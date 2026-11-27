import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { storageFixture } from './helpers/storage.js';
import { createMembersApi, memberError } from '../src/members-api.js';
import { notificationLabel } from '../src/notifications-api.js';

const db = new PGlite();
const id = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function asUser(n, sql, args = []) {
  await db.exec('begin;set local role authenticated');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [n ? id(n) : '']);
    const { rows } = await db.query(sql, args); await db.exec('commit'); return rows;
  } catch (e) { await db.exec('rollback'); throw e; }
}
const rpc = async (n, sql, args) => (await asUser(n, sql, args))[0]?.value;
const directory = (n, search = '', section = 'discover', page = 0) => rpc(n, 'select public.social_directory($1,$2,$3) as value', [search, section, page]);
const action = (n, peer, value) => rpc(n, 'select public.social_friend_action($1,$2) as value', [id(peer), value]);
const save = (n, bio = '', interests = '', languages = '', discoverable = true, requests = true) => rpc(n, 'select public.social_save_profile($1,$2,$3,$4,$5) as value', [bio, interests, languages, discoverable, requests]);
const inbox = n => rpc(n, 'select public.notice_inbox() as value');
const block = (n, peer, value) => rpc(n, 'select public.dm_set_block($1,$2) as value', [id(peer), value]);
const denies = fn => assert.rejects(fn, e => e.code === '42501');

before(async () => {
  await db.exec(`create role anon;create role authenticated;create schema auth;grant usage on schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,created_at timestamptz default now()-interval '1 day',deleted_at timestamptz,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create publication supabase_realtime;`);
  await db.exec(storageFixture);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(x => x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'));
  for (let n = 1; n <= 100; n++) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,case when $3<>99 then now() end)', [id(n), `friend${n}@example.invalid`, n]);
    if (n !== 100) await db.query('insert into public.profiles(id,name,username,country,school) values($1,$2,$3,$4,$5)', [id(n), `Local member ${String(n).padStart(3, '0')}`, `friend_${n}`, 'Türkiye', 'Local School']);
  }
});
after(() => db.close());

test('requests are idempotent, recipient-approved, private, and notify both sides at the right time', async () => {
  assert.equal(await action(1, 2, 'request'), 'pending');
  assert.equal(await action(1, 2, 'request'), 'pending');
  assert.equal(await action(2, 1, 'request'), 'pending', 'crossed requests cannot auto-accept');
  assert.equal((await inbox(2)).items.length, 1);
  assert.equal((await inbox(1)).items.length, 0);
  await denies(() => action(1, 2, 'accept'));
  await denies(() => action(1, 2, 'decline'));
  await denies(() => action(2, 1, 'cancel'));
  await denies(() => action(3, 1, 'accept'));
  assert.deepEqual(await asUser(3, 'select * from public.friendships'), []);
  assert.equal((await directory(2, '', 'requests')).incoming_count, 1);
  assert.equal(await action(2, 1, 'accept'), 'accepted');
  assert.equal(await action(2, 1, 'accept'), 'accepted');
  assert.equal((await directory(1, '', 'friends')).items[0].id, id(2));
  assert.equal((await directory(2, '', 'friends')).friends_count, 1);
  assert.equal((await inbox(1)).items[0].kind, 'friend_accepted');
  assert.equal((await inbox(1)).items.length, 1);
  assert.equal((await inbox(2)).unread_count, 0);
  assert.equal((await inbox(2)).items[0].unavailable, true);
  await assert.rejects(() => action(1, 2, 'cancel'), e => e.code === '22023');
  assert.equal(await action(1, 2, 'remove'), 'removed');
  assert.equal((await directory(2, '', 'friends')).friends_count, 0);
  assert.equal((await inbox(1)).unread_count, 0);
});

test('cancel/decline archive notices and enforce a seven-day retry cooldown', async () => {
  await action(4, 5, 'request'); await action(4, 5, 'cancel');
  assert.equal((await inbox(5)).unread_count, 0);
  await assert.rejects(() => action(4, 5, 'request'), e => e.code === 'P0001');
  await db.query("update public.friendships set updated_at=now()-interval '8 days' where user_low=$1", [id(4)]);
  await action(4, 5, 'request');
  assert.equal((await inbox(5)).unread_count, 1, 'new request gets a new notification version');
  await action(5, 4, 'decline');
  await assert.rejects(() => action(5, 4, 'accept'), e => e.code === '22023');
  assert.equal((await directory(4, '', 'requests')).items.length, 0);
  await assert.rejects(() => action(5, 4, 'request'), e => e.code === 'P0001');
});

test('discovery and request privacy preserve existing relationships without leaking emails', async () => {
  await save(6, ' A small bio ', 'Robotics, chess', 'Turkish, English', false);
  assert.equal((await directory(7, '@friend_6')).items.some(p => p.id === id(6)), false);
  await denies(() => action(7, 6, 'request'));
  await save(6, 'A small bio', 'Robotics, chess', 'Turkish, English', true, false);
  const person = (await directory(7, '@friend_6')).items[0];
  assert.equal(person.bio, 'A small bio'); assert.equal(person.allow_requests, false);
  assert.equal(JSON.stringify(person).includes('@example.invalid'), false);
  await denies(() => action(7, 6, 'request'));
  await save(6); await action(7, 6, 'request');
  await save(6, '', '', '', false, false);
  assert.equal((await directory(7, '', 'requests')).items[0].id, id(6));
  await action(6, 7, 'accept');
  assert.equal((await directory(7, '', 'friends')).items[0].id, id(6));
  assert.deepEqual(await asUser(7, 'select * from public.member_details where user_id=$1', [id(6)]), []);
});

test('blocks prevent discovery and requests in both directions; unblocking cannot restore friendship', async () => {
  await action(8, 9, 'request'); await action(9, 8, 'accept');
  await block(8, 9, true);
  for (const [a, b] of [[8, 9], [9, 8]]) {
    assert.equal((await directory(a, `@friend_${b}`)).items.some(p => p.id === id(b)), false);
    assert.equal((await directory(a, '', 'friends')).items.length, 0);
    await denies(() => action(a, b, 'request'));
    assert.deepEqual(await asUser(a, 'select * from public.friendships'), []);
  }
  await block(8, 9, false);
  assert.equal((await directory(8, '', 'friends')).items.length, 0);
  assert.equal((await inbox(8)).unread_count, 0);
  await action(10, 11, 'request'); await block(11, 10, true); await block(11, 10, false);
  assert.equal((await directory(10, '', 'requests')).items.length, 0);
});

test('verified profiles are mandatory and clients cannot forge friendship/profile state or call internal helpers', async () => {
  for (const n of [null, 99, 100]) {
    await denies(() => directory(n)); await denies(() => save(n)); await denies(() => action(n, 12, 'request'));
  }
  for (const n of [99, 100]) await denies(() => action(12, n, 'request'));
  for (const sql of [
    "update public.friendships set status='accepted'",
    'delete from public.friendships',
    "insert into public.friendships(user_low,user_high,requester_id) values($1,$2,$1)",
    "insert into public.member_details(user_id,bio) values($1,'forged')",
    "update public.member_details set bio='forged'",
    'select * from interoom_private.friend_request_events',
    'select interoom_private.social_archive_notices($1)',
  ]) await denies(() => asUser(12, sql, sql.includes('$2') ? [id(12), id(13)] : sql.includes('$1') ? [id(12)] : []));
  await db.exec('begin;set local role anon');
  await assert.rejects(() => db.query('select public.social_directory()'), e => e.code === '42501');
  await db.exec('rollback');
});

test('request limits cannot be bypassed by cancelling; daily cap also applies', async () => {
  for (let n = 21; n <= 30; n++) { await action(20, n, 'request'); await action(20, n, 'cancel'); }
  await assert.rejects(() => action(20, 31, 'request'), e => e.code === 'P0001');
  await db.query("insert into interoom_private.friend_request_events(actor_id,created_at) select $1,now()-interval '2 hours' from generate_series(1,50)", [id(32)]);
  await assert.rejects(() => action(32, 33, 'request'), e => e.code === 'P0001');
});

test('profile edits derive ownership and validate fields; directory search is literal and paginated', async () => {
  await save(14, ' Bio ', 'UniqueRobotics', 'Türkçe');
  assert.equal((await directory(14)).own.bio, 'Bio');
  assert.equal((await directory(15, 'uniquerobotics')).items[0].id, id(14));
  assert.equal((await directory(15, '%')).items.length, 0);
  for (const call of [() => save(14, 'x'.repeat(281)), () => save(14, '', 'x'.repeat(161)), () => save(14, '', '', 'x'.repeat(121)), () => save(14, null), () => directory(14, '', 'invalid'), () => directory(14, '', 'discover', -1), () => action(14, 14, 'request')]) await assert.rejects(call, e => e.code === '22023');
  const first = await directory(15), second = await directory(15, '', 'discover', 1);
  assert.equal(first.items.length, 24); assert.equal(second.items.length, 24);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 48);
  assert.deepEqual((await directory(15)).items, first.items);
  assert.equal((await directory(15, '@friend_99')).total, 0);
});

test('message availability respects new-conversation privacy while keeping existing threads open', async () => {
  await rpc(16, 'select public.dm_start_conversation($1) as value', [id(17)]);
  await db.query('insert into public.dm_preferences(user_id,allow_new_conversations) values($1,false)', [id(17)]);
  assert.equal((await directory(16, '@friend_17')).items[0].can_message, true);
  assert.equal((await directory(18, '@friend_17')).items[0].can_message, false);
});

test('client sends only permitted profile fields and preserves failed operations as failures', async () => {
  let args; const api = createMembersApi({ rpc: async (name, value) => { args = value; return name === 'social_friend_action' ? { error: { code: '42501' } } : { data: null }; } });
  await api.save({ bio: 'hello', interests: '', languages: '', discoverable: true, allow_requests: true, user_id: 'forged' });
  assert.equal('user_id' in args, false);
  await assert.rejects(() => api.act('peer', 'accept'));
  assert.equal(memberError({ message: 'secret database detail' }).includes('secret'), false);
  assert.equal(notificationLabel({ kind: 'friend_request', name: 'Student' }), 'Student sent you a friend request');
  assert.equal(notificationLabel({ kind: 'friend_accepted', name: 'Student' }), 'Student accepted your friend request');
});

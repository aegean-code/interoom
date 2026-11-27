import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { storageFixture } from './helpers/storage.js';
import { createAvatarApi, PHOTO_PATH, photoError } from '../src/avatar-api.js';
import { cropRectangle, validatePhotoFile } from '../src/photo-image.js';

const db = new PGlite();
const id = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const path = (user, image) => `${id(user)}/${id(image)}.jpg`;
async function asUser(n, sql, args = []) {
  await db.exec('begin;set local role authenticated');
  try { await db.query("select set_config('request.jwt.claim.sub',$1,true)", [n ? id(n) : '']); const { rows } = await db.query(sql, args); await db.exec('commit'); return rows; }
  catch (e) { await db.exec('rollback'); throw e; }
}
const rpc = async (n, sql, args) => (await asUser(n, sql, args))[0]?.value;
const upload = (n, key, mime = 'image/jpeg', size = 1024) => asUser(n, "insert into storage.objects(bucket_id,name,owner_id,metadata) values('profile-photos',$1,$2,$3)", [key, id(n), { mimetype: mime, size }]);
const save = (n, next, expected = null) => rpc(n, 'select public.profile_set_avatar($1,$2) as value', [next, expected]);
const files = n => asUser(n, "select name from storage.objects where bucket_id='profile-photos'");
const remove = (n, key) => asUser(n, 'delete from storage.objects where name=$1 returning name', [key]);
const denied = fn => assert.rejects(fn, e => e.code === '42501');

before(async () => {
  await db.exec(`create role anon;create role authenticated;create schema auth;grant usage on schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,created_at timestamptz default now()-interval '1 day',deleted_at timestamptz,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create publication supabase_realtime;`);
  await db.exec(storageFixture);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(x => x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'));
  for (let n = 1; n <= 5; n++) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,case when $3<>4 then now() end)', [id(n), `photo${n}@example.invalid`, n]);
    if (n !== 5) await db.query('insert into public.profiles(id,name,username) values($1,$2,$3)', [id(n), `Photo member ${n}`, `photo_${n}`]);
  }
});
after(() => db.close());

test('only verified owners can upload and publish a photo; direct profile writes cannot bypass checks', async () => {
  for (const n of [null, 4, 5]) { await denied(() => upload(n, path(n || 1, 1))); await denied(() => save(n, null)); }
  await denied(() => upload(1, path(2, 1)));
  await denied(() => upload(1, `${id(1)}/payload.svg`));
  await upload(1, path(1, 11));
  assert.deepEqual(await files(2), [], 'unpublished files are private to their owner');
  assert.equal(await save(1, path(1, 11)), path(1, 11));
  await assert.rejects(() => save(2, path(1, 11)), e => e.code === '22023');
  await denied(() => asUser(1, 'update public.profiles set avatar_path=$1', [path(1, 12)]));
  await db.exec('begin;set local role anon');
  await assert.rejects(() => db.query('select public.profile_set_avatar(null)'), e => e.code === '42501'); await db.exec('rollback');
  const bucket = (await db.query("select * from storage.buckets where id='profile-photos'")).rows[0];
  assert.equal(bucket.public, false); assert.equal(Number(bucket.file_size_limit), 524288); assert.deepEqual(bucket.allowed_mime_types, ['image/jpeg']);
});

test('only the current photo is shared; other users cannot replace or delete it', async () => {
  await upload(1, path(1, 12)); await save(1, path(1, 12), path(1, 11));
  assert.deepEqual(await files(2), [{ name: path(1, 12) }]);
  assert.deepEqual(await remove(2, path(1, 12)), []);
  assert.deepEqual(await remove(1, path(1, 12)), [], 'protect a saved photo from stale cleanup');
  assert.deepEqual(await asUser(1, "update storage.objects set metadata='{}' where name=$1 returning name", [path(1, 12)]), []);
  assert.deepEqual(await remove(1, path(1, 11)), [{ name: path(1, 11) }]);
  await rpc(2, 'select public.dm_set_block($1,true) as value', [id(1)]);
  assert.deepEqual(await files(2), []);
  await rpc(2, 'select public.dm_set_block($1,false) as value', [id(1)]);
});

test('photos propagate to directory, own profile, messaging and notifications', async () => {
  const directory = await rpc(2, 'select public.social_directory() as value');
  assert.equal(directory.items.find(p => p.id === id(1)).avatar_path, path(1, 12));
  assert.equal((await rpc(1, 'select public.social_directory() as value')).own.avatar_path, path(1, 12));
  await rpc(1, "select public.social_friend_action($1,'request') as value", [id(2)]);
  const notice = (await rpc(2, 'select public.notice_inbox() as value')).items[0];
  assert.equal(notice.avatar_path, path(1, 12)); assert.equal(notice.actor_id, id(1));
  assert.equal((await rpc(2, "select public.dm_search_members('photo_1') as value"))[0].avatar_path, path(1, 12));
  await rpc(2, 'select public.dm_start_conversation($1) as value', [id(1)]);
  assert.equal((await rpc(2, 'select public.dm_inbox() as value')).items[0].avatar_path, path(1, 12));
});

test('stale saves cannot overwrite another tab and removal preserves other profile fields', async () => {
  await upload(1, path(1, 13)); await save(1, path(1, 13), path(1, 12));
  await assert.rejects(() => save(1, null, path(1, 12)), e => e.code === '40001');
  assert.deepEqual(await remove(1, path(1, 13)), []);
  await save(1, null, path(1, 13));
  const own = (await asUser(1, 'select name,username,avatar_path from public.profiles where id=$1', [id(1)]))[0];
  assert.deepEqual(own, { name: 'Photo member 1', username: 'photo_1', avatar_path: null });
  await remove(1, path(1, 12)); await remove(1, path(1, 13));
  assert.deepEqual(await files(2), []);
});

test('upload quota and server checks reject missing, oversized, and wrong-type photos', async () => {
  await assert.rejects(() => save(3, path(3, 1)), e => e.code === '22023');
  for (let i = 1; i <= 4; i++) await upload(3, path(3, i), i === 1 ? 'image/svg+xml' : 'image/jpeg', i === 2 ? 600000 : 1024);
  await denied(() => upload(3, path(3, 5)));
  await assert.rejects(() => save(3, path(3, 1)), e => e.code === '22023');
  await assert.rejects(() => save(3, path(3, 2)), e => e.code === '22023');
  await remove(3, path(3, 1)); await upload(3, path(3, 5)); await save(3, path(3, 5));
});

test('client rejects SVG, disguised files and oversized uploads and bounds crop to the source', async () => {
  await assert.rejects(() => validatePhotoFile(new Blob(['<svg/>'], { type: 'image/jpeg' })));
  await assert.rejects(() => validatePhotoFile(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)])));
  await validatePhotoFile(new Blob([new Uint8Array([255,216,255,0])]));
  assert.deepEqual(cropRectangle(1200, 800), { x: 200, y: 0, side: 800 });
  assert.deepEqual(cropRectangle(800, 1200, 2, 100, 0), { x: 400, y: 0, side: 400 });
  assert.equal(PHOTO_PATH.test('https://tracker.example/photo.jpg'), false);
  assert.equal(PHOTO_PATH.test(path(1, 1)), true);
});

test('signed URLs are deduplicated and errors do not poison the cache', async () => {
  let calls = 0;
  const api = createAvatarApi({ storage: { from: () => ({ createSignedUrl: async () => { calls++; return calls === 1 ? { error: new Error('offline') } : { data: { signedUrl: 'https://image.invalid/signed' } }; } }) } });
  await assert.rejects(() => api.url(path(1, 1))); await Promise.all([api.url(path(1, 1)), api.url(path(1, 1))]);
  assert.equal(calls, 2); assert.equal(await api.url('https://evil.example/image'), null);
  assert.equal(photoError({ message: 'secret' }).includes('secret'), false);
});

test('upload failures cannot change the profile; publish failures clean up only their new object', async () => {
  const calls = []; let uploadError = true;
  const storage = { list: async () => ({ data: [] }), remove: async paths => { calls.push(['remove', paths]); return {}; }, upload: async (key, blob, options) => { calls.push(['upload', key, options]); return uploadError ? { error: new Error('offline') } : {}; } };
  const api = createAvatarApi({ storage: { from: () => storage }, rpc: async (name, args) => { calls.push(['publish', args]); return { error: { code: '40001' } }; } });
  const blob = new Blob(['photo'], { type: 'image/jpeg' });
  await assert.rejects(() => api.save(id(1), blob)); assert.equal(calls.some(c => c[0] === 'publish'), false);
  uploadError = false; await assert.rejects(() => api.save(id(1), blob, path(1, 1)));
  assert.deepEqual(calls.find(c => c[0] === 'publish')[1].expected_path, path(1, 1));
  const removed = calls.find(c => c[0] === 'remove')[1]; assert.equal(removed.includes(path(1, 1)), false);
  assert.equal(calls.filter(c => c[0] === 'upload').every(c => c[2].upsert === false), true);
});

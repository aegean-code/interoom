import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let conversation, first, second;
async function asUser(n, query, values = []) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [n ? id(n) : '']);
    const result = await db.query(query, values);
    await db.exec('commit');
    return result.rows;
  } catch (error) { await db.exec('rollback'); throw error; }
}
const rpc = async (n, sql, values) => (await asUser(n, sql, values))[0]?.value;
const denied = operation => assert.rejects(operation, error => error.code === '42501');

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    grant usage on schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
      created_at timestamptz default now(),deleted_at timestamptz,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create publication supabase_realtime;`);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
  for (let n = 1; n <= 20; n++) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,case when $3<>4 then now() end)', [id(n), `fixture${n}@example.invalid`, n]);
    await db.query('insert into public.profiles(id,name,username) values($1,$2,$3)', [id(n), `Local student ${n}`, `local_${n}`]);
  }
});
after(() => db.close());

test('one canonical conversation, persistent bidirectional history and unread counts', async () => {
  conversation = await rpc(1, 'select public.dm_start_conversation($1) as value', [id(2)]);
  assert.equal(await rpc(2, 'select public.dm_start_conversation($1) as value', [id(1)]), conversation);
  first = await rpc(1, 'select to_jsonb(public.dm_send_message($1,$2,$3)) as value', [conversation,'Hello from one',id(101)]);
  second = await rpc(2, 'select to_jsonb(public.dm_send_message($1,$2,$3)) as value', [conversation,'Hello from two',id(102)]);
  assert.equal((await asUser(1, 'select * from public.dm_get_messages($1)', [conversation])).length, 2);
  assert.equal((await asUser(2, 'select * from public.dm_get_messages($1)', [conversation])).length, 2);
  const inbox = await rpc(1, 'select public.dm_inbox() as value');
  assert.equal(inbox.unread_count, 1);
  assert.equal(inbox.items[0].last_message.body, 'Hello from two');
  assert.equal(inbox.items[0].username, 'local_2');
  assert.equal(inbox.preferences.show_online, false);
  assert.equal(inbox.items[0].is_online, null);
});

test('third parties cannot read, send, report, delete, forge receipts or write tables directly', async () => {
  assert.deepEqual(await asUser(3, 'select * from public.dm_messages'), []);
  assert.deepEqual(await asUser(3, 'select * from public.dm_conversations'), []);
  assert.deepEqual(await asUser(3, 'select * from public.dm_get_messages($1)', [conversation]), []);
  assert.equal((await rpc(3, 'select public.dm_inbox() as value')).unread_count, 0);
  await denied(() => rpc(3, 'select public.dm_send_message($1,$2,$3) as value', [conversation,'intrusion',id(103)]));
  await denied(() => rpc(3, 'select public.dm_mark_read($1,$2) as value', [conversation,first.id]));
  await denied(() => rpc(3, 'select public.dm_delete_message($1) as value', [first.id]));
  await denied(() => rpc(3, 'select public.dm_report_message($1,$2) as value', [first.id,'not a participant']));
  await denied(() => asUser(1, 'update public.dm_messages set sender_id=$1 where id=$2', [id(2),first.id]));
  await denied(() => asUser(1, 'insert into public.dm_reads values($1,$2,99999)', [conversation,id(2)]));
  await denied(() => asUser(1, 'select * from interoom_private.dm_reports'));
});

test('unverified, deleted and anonymous identities cannot use private messages', async () => {
  await denied(() => rpc(4, 'select public.dm_inbox() as value'));
  await denied(() => rpc(null, 'select public.dm_inbox() as value'));
  assert.deepEqual(await asUser(4, 'select * from public.dm_messages'), []);
  await db.query('update auth.users set deleted_at=now() where id=$1', [id(4)]);
  await denied(() => rpc(1, 'select public.dm_start_conversation($1) as value', [id(4)]));
  await db.exec('begin; set local role anon');
  await assert.rejects(() => db.query('select public.dm_inbox()'), e => e.code === '42501');
  await db.exec('rollback');
});

test('retry nonce is idempotent and cannot be reused for a different message', async () => {
  const retry = await rpc(1, 'select to_jsonb(public.dm_send_message($1,$2,$3)) as value', [conversation,'Hello from one',id(101)]);
  assert.equal(retry.id, first.id);
  await assert.rejects(() => rpc(1, 'select public.dm_send_message($1,$2,$3) as value', [conversation,'different text',id(101)]), e=>e.code==='22023');
  assert.equal((await asUser(1, 'select * from public.dm_messages')).length, 2);
});

test('read receipts advance monotonically and cannot jump beyond a real conversation message', async () => {
  await rpc(1,'select public.dm_mark_read($1,$2) as value',[conversation,second.id]);
  await rpc(1,'select public.dm_mark_read($1,$2) as value',[conversation,first.id]);
  assert.equal((await rpc(1,'select public.dm_inbox() as value')).unread_count,0);
  assert.equal((await rpc(2,'select public.dm_inbox() as value')).items[0].peer_read_sequence,second.sequence);
  await assert.rejects(() => rpc(1,'select public.dm_mark_read($1,$2) as value',[conversation,id(999)]),e=>e.code==='22023');
});

test('blocking works in both directions, retains history, hides presence and receipts', async () => {
  await rpc(2,'select public.dm_set_preferences(true,true) as value');
  assert.equal((await rpc(1,'select public.dm_inbox() as value')).items[0].is_online,true);
  assert.deepEqual(await asUser(3,'select * from public.dm_presence'),[]);
  await rpc(1,'select public.dm_set_block($1,true) as value',[id(2)]);
  for (const [sender,peer] of [[1,2],[2,1]]) {
    await denied(() => rpc(sender,'select public.dm_start_conversation($1) as value',[id(peer)]));
    await denied(() => rpc(sender,'select public.dm_send_message($1,$2,$3) as value',[conversation,'blocked',id(200+sender)]));
    const row=(await rpc(sender,'select public.dm_inbox() as value')).items[0];
    assert.equal(row.can_message,false); assert.equal(row.is_online,null); assert.equal(row.peer_read_sequence,0);
    assert.equal((await asUser(sender,'select * from public.dm_messages')).length,2);
  }
  assert.equal((await asUser(2,'select * from public.user_blocks')).length,0);
  await rpc(1,'select public.dm_set_block($1,false) as value',[id(2)]);
  assert.equal((await rpc(2,'select public.dm_inbox() as value')).items[0].can_message,true);
});

test('reports retain only reported evidence and deletion removes message text for participants', async () => {
  await rpc(2,'select public.dm_report_message($1,$2) as value',[first.id,'Test report reason']);
  await rpc(2,'select public.dm_report_message($1,$2) as value',[first.id,'Repeated report']);
  await denied(() => rpc(2,'select public.dm_delete_message($1) as value',[first.id]));
  await rpc(1,'select public.dm_delete_message($1) as value',[first.id]);
  const row=(await asUser(2,'select * from public.dm_messages where id=$1',[first.id]))[0];
  assert.equal(row.body,null); assert.ok(row.deleted_at);
  const reports=await db.query('select * from interoom_private.dm_reports');
  assert.equal(reports.rows.length,1); assert.equal(reports.rows[0].message_snapshot,'Hello from one');
});

test('privacy preferences prevent new conversations and search exposes no emails', async () => {
  await rpc(3,'select public.dm_set_preferences(false,false) as value');
  await denied(() => rpc(1,'select public.dm_start_conversation($1) as value',[id(3)]));
  const search=await rpc(1,'select public.dm_search_members($1) as value',['@local_2']);
  assert.equal(search[0].id,id(2));
  assert.deepEqual(Object.keys(search[0]).sort(),['id','name','username']);
  assert.equal((await rpc(1,'select public.dm_search_members($1) as value',['local_3'])).length,0);
});

test('blocked users can clear their own unread counts without revealing receipts', async () => {
  await rpc(2,'select public.dm_set_block($1,true) as value',[id(1)]);
  await rpc(2,'select public.dm_mark_read($1,$2) as value',[conversation,second.id]);
  assert.equal((await rpc(2,'select public.dm_inbox() as value')).unread_count,0);
  assert.equal((await rpc(1,'select public.dm_inbox() as value')).items[0].peer_read_sequence,0);
  await rpc(2,'select public.dm_set_block($1,false) as value',[id(1)]);
});

test('conversation deep links return only a participant’s chosen conversation', async () => {
  assert.equal((await rpc(1,'select public.dm_inbox(0,$1) as value',[conversation])).items[0].id,conversation);
  assert.deepEqual((await rpc(3,'select public.dm_inbox(0,$1) as value',[conversation])).items,[]);
});

test('conversation creation limits are enforced without preventing existing conversations', async () => {
  for(let n=5;n<=13;n++) await rpc(1,'select public.dm_start_conversation($1) as value',[id(n)]);
  await assert.rejects(()=>rpc(1,'select public.dm_start_conversation($1) as value',[id(14)]),e=>e.code==='P0001');
  assert.equal(await rpc(1,'select public.dm_start_conversation($1) as value',[id(2)]),conversation);
});

test('history uses stable pagination and rate limits cannot be reset by deleting messages', async () => {
  // Additional rows are isolated fixtures, inserted as the local test owner.
  for(let n=0;n<55;n++) await db.query('insert into public.dm_messages(conversation_id,sender_id,client_nonce,body,created_at) values($1,$2,$3,$4,now()-interval \'2 hours\')',[conversation,id(1),id(300+n),`history ${n}`]);
  const page1=await asUser(2,'select * from public.dm_get_messages($1)',[conversation]);
  const page2=await asUser(2,'select * from public.dm_get_messages($1,$2)',[conversation,page1.at(-1).sequence]);
  assert.equal(page1.length,50);assert.equal(page2.length,7);assert.equal(new Set([...page1,...page2].map(m=>m.id)).size,57);
  for(let n=0;n<29;n++) await rpc(1,'select public.dm_send_message($1,$2,$3) as value',[conversation,`rate ${n}`,id(400+n)]);
  await assert.rejects(()=>rpc(1,'select public.dm_send_message($1,$2,$3) as value',[conversation,'too fast',id(500)]),e=>e.code==='P0001');
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { storageFixture } from './helpers/storage.js';

const db = new PGlite();
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function asUser(n, query, values = []) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [n ? id(n) : '']);
    const result = await db.query(query, values); await db.exec('commit'); return result.rows;
  } catch (error) { await db.exec('rollback'); throw error; }
}
const rpc = async (n, sql, values) => (await asUser(n, sql, values))[0]?.value;
const inbox = n => rpc(n, 'select public.notice_inbox() as value');
const post = async (n, body = 'Local post', room = 'general') => {
  await asUser(n, 'insert into public.posts(room_id,body) values($1,$2)', [room, body]);
  return (await db.query('select id from public.posts where author_id=$1 order by created_at desc,id desc limit 1', [id(n)])).rows[0].id;
};
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    grant usage on schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
      created_at timestamptz default now()-interval '1 day',deleted_at timestamptz,is_anonymous boolean default false);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create publication supabase_realtime;`);
  await db.exec(storageFixture);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'));
  for (let n=1;n<=15;n++) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,case when $3<>9 then now() end)',[id(n),`notice${n}@example.invalid`,n]);
    await db.query('insert into public.profiles(id,name,username) values($1,$2,$3)',[id(n),`Local member ${n}`,`notice_${n}`]);
  }
});
after(()=>db.close());

test('private messages coalesce per conversation without exposing text, and receipts clear notifications',async()=>{
  const conv=await rpc(1,'select public.dm_start_conversation($1) as value',[id(2)]);
  const first=await rpc(1,'select to_jsonb(public.dm_send_message($1,$2,$3)) as value',[conv,'Private fixture text',id(101)]);
  await rpc(1,'select public.dm_send_message($1,$2,$3) as value',[conv,'Private fixture text',id(101)]);
  const stale=(await inbox(2)).items[0];
  const second=await rpc(1,'select to_jsonb(public.dm_send_message($1,$2,$3)) as value',[conv,'Second private fixture',id(102)]);
  const notices=await inbox(2);
  assert.equal(notices.items.length,1); assert.equal(notices.unread_count,1); assert.equal(notices.items[0].version,2);
  assert.equal((await inbox(1)).items.length,0);
  assert.equal(JSON.stringify(await asUser(2,'select * from public.notifications')).includes('Private fixture text'),false);
  await rpc(2,'select public.notice_mark_read($1,$2) as value',[stale.id,stale.version]);
  assert.equal((await inbox(2)).unread_count,1,'stale UI must not clear a newer DM notification');
  await rpc(2,'select public.dm_mark_read($1,$2) as value',[conv,first.id]);
  assert.equal((await inbox(2)).unread_count,1);
  await rpc(2,'select public.dm_mark_read($1,$2) as value',[conv,second.id]);
  assert.equal((await inbox(2)).unread_count,0);
});

test('only recipients can read/mark notifications and clients cannot forge them',async()=>{
  const notice=(await inbox(2)).items[0];
  assert.deepEqual(await asUser(3,'select * from public.notifications'),[]);
  await rpc(3,'select public.notice_mark_read($1,$2) as value',[notice.id,notice.version]);
  for (const operation of [
    ()=>asUser(2,'update public.notifications set recipient_id=$1',[id(3)]),
    ()=>asUser(2,"insert into public.notifications(recipient_id,actor_id,kind,event_key) values($1,$2,'reply','forged')",[id(3),id(2)]),
    ()=>rpc(2,"select interoom_private.notice_add($1,$2,'reply','forged') as value",[id(2),id(3)]),
    ()=>inbox(null),()=>inbox(9),
  ]) await assert.rejects(operation,e=>e.code==='42501');
  await db.exec('begin;set local role anon;');
  await assert.rejects(()=>db.query('select public.notice_inbox()'),e=>e.code==='42501'); await db.exec('rollback');
});

test('replies and reactions notify the author once, excluding own actions',async()=>{
  const target=await post(3);
  await asUser(4,'insert into public.replies(post_id,body) values($1,$2)',[target,'Local reply']);
  await asUser(3,'insert into public.replies(post_id,body) values($1,$2)',[target,'Author reply']);
  await asUser(4,'insert into public.reactions(post_id) values($1)',[target]);
  await asUser(4,'delete from public.reactions where post_id=$1',[target]);
  await asUser(4,'insert into public.reactions(post_id) values($1)',[target]);
  await asUser(3,'insert into public.reactions(post_id) values($1)',[target]);
  assert.deepEqual((await inbox(3)).items.map(x=>x.kind).sort(),['reaction','reply']);
  assert.equal((await inbox(4)).items.length,0);
  await asUser(3,'delete from public.posts where id=$1',[target]);
  const removed=await inbox(3);
  assert.equal(removed.unread_count,0); assert(removed.items.every(x=>x.unavailable));
});

test('mentions are exact, bounded, deduplicated, and do not double-notify a reply author',async()=>{
  const target=await post(5,'@notice_6 @NOTICE_6 email@notice_7 @notice_5 @notice_9');
  assert.equal((await inbox(6)).items.length,1); assert.equal((await inbox(7)).items.length,0);
  assert.equal((await inbox(5)).items.length,0);
  assert.equal((await db.query('select count(*)::int as count from public.notifications where recipient_id=$1',[id(9)])).rows[0].count,0);
  await asUser(6,'insert into public.replies(post_id,body) values($1,$2)',[target,'Hello @notice_5 and @notice_7']);
  assert.equal((await inbox(5)).items.length,1); assert.equal((await inbox(5)).items[0].kind,'reply');
  assert.equal((await inbox(7)).items[0].kind,'mention');
  await post(5,'@notice_1 @notice_2 @notice_3 @notice_4 @notice_6 @notice_7 @notice_8');
  const mentionCounts=(await db.query("select count(*)::int as count from public.notifications where actor_id=$1 and kind='mention'",[id(5)])).rows[0].count;
  assert.equal(mentionCounts,6,'one earlier mention plus at most five new recipients');
});

test('blocking suppresses notifications and hides prior activity from the notification center',async()=>{
  await rpc(6,'select public.dm_set_block($1,true) as value',[id(5)]);
  assert.equal((await inbox(6)).items.length,0);
  const before=(await db.query('select count(*)::int as count from public.notifications where recipient_id=$1',[id(6)])).rows[0].count;
  await post(5,'Blocked mention @notice_6');
  assert.equal((await db.query('select count(*)::int as count from public.notifications where recipient_id=$1',[id(6)])).rows[0].count,before);
});

test('mark all read respects its snapshot and does not mark later activity',async()=>{
  const target=await post(8);
  await asUser(10,'insert into public.replies(post_id,body) values($1,$2)',[target,'Before snapshot']);
  const snapshot=await inbox(8);
  await asUser(10,'insert into public.replies(post_id,body) values($1,$2)',[target,'After snapshot']);
  await rpc(8,'select public.notice_mark_all_read($1) as value',[snapshot.snapshot_at]);
  assert.equal((await inbox(8)).unread_count,1);
  await assert.rejects(()=>rpc(8,"select public.notice_mark_all_read(now()+interval '1 day') as value"),e=>e.code==='22023');
});

test('notification rate limits do not fail legitimate replies',async()=>{
  const target=await post(11);
  for(let i=0;i<24;i++) await asUser(12,'insert into public.replies(post_id,body) values($1,$2)',[target,`Rate fixture ${i}`]);
  assert.equal((await inbox(11)).items.length,20);
  assert.equal((await db.query('select count(*)::int as count from public.replies where post_id=$1',[target])).rows[0].count,24);
});

test('room counters separate posts/chat, exclude self, and only advance through a real loaded entry',async()=>{
  const first=await post(13,'Room activity one','culture-exchange');
  const second=await post(13,'Room activity two','culture-exchange');
  await asUser(13,"insert into public.messages(room_id,body) values('culture-exchange','Room chat fixture')");
  const counts=async n=>(await rpc(n,'select public.notice_room_counts() as value')).filter(x=>x.room_id==='culture-exchange');
  assert.deepEqual((await counts(14)).map(x=>[x.view,x.unread_count]).sort(),[['chat',1],['posts',2]]);
  assert.equal((await counts(13)).length,0);
  await rpc(14,'select public.notice_read_room($1,$2,$3) as value',['culture-exchange','posts',first]);
  assert.equal((await counts(14)).find(x=>x.view==='posts').unread_count,1);
  await rpc(14,'select public.notice_read_room($1,$2,$3) as value',['general','posts',second]);
  assert.equal((await counts(14)).find(x=>x.view==='posts').unread_count,1,'wrong room must not clear unread');
  await rpc(14,'select public.notice_read_room($1,$2,$3) as value',['culture-exchange','posts',second]);
  await rpc(14,'select public.notice_read_room($1,$2,$3) as value',['culture-exchange','posts',first]);
  assert.equal((await counts(14)).some(x=>x.view==='posts'),false,'read markers never move backwards');
  assert.deepEqual(await asUser(15,'select * from public.room_reads'),[]);
  await assert.rejects(()=>asUser(14,'update public.room_reads set last_read_sequence=999'),e=>e.code==='42501');
  await asUser(13,'delete from public.posts where id=$1',[second]);
  assert.equal((await counts(15)).find(x=>x.view==='posts').unread_count,1);
});

test('deleting an unread private message clears its notification without exposing a preview',async()=>{
  const conv=await rpc(14,'select public.dm_start_conversation($1) as value',[id(15)]);
  const msg=await rpc(14,'select to_jsonb(public.dm_send_message($1,$2,$3)) as value',[conv,'Delete notification fixture',id(115)]);
  assert.equal((await inbox(15)).unread_count,1);
  await rpc(14,'select public.dm_delete_message($1) as value',[msg.id]);
  const notices=await inbox(15);assert.equal(notices.unread_count,0);assert.equal(notices.items[0].unavailable,true);
});

test('notification pagination has no duplicates and mark-all covers unloaded pages',async()=>{
  const target=await post(14);
  for(const author of [11,12]) for(let i=0;i<18;i++) await asUser(author,'insert into public.replies(post_id,body) values($1,$2)',[target,`Page fixture ${author} ${i}`]);
  const first=await inbox(14),second=await rpc(14,'select public.notice_inbox(1) as value');
  assert.equal(first.items.length,30);assert.equal(second.items.length,6);assert.equal(first.total,36);
  assert.equal(new Set([...first.items,...second.items].map(n=>n.id)).size,36);
  await rpc(14,'select public.notice_mark_all_read($1) as value',[first.snapshot_at]);
  assert.equal((await inbox(14)).unread_count,0);
  await assert.rejects(()=>rpc(14,'select public.notice_inbox(-1) as value'),e=>e.code==='22023');
});

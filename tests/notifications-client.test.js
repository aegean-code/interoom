import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationsApi, notificationLabel } from '../src/notifications-api.js';
import { roomUrl, currentRoute } from '../src/routing.js';

test('notification subscriptions filter recipients, recover status and clean up',()=>{
  const subscriptions=[];let removed,called=0;
  const channel={on:(kind,filter,callback)=>{subscriptions.push(filter);callback();return channel;},subscribe:callback=>{callback('SUBSCRIBED');return channel;}};
  const api=createNotificationsApi({channel:()=>channel,removeChannel:ch=>{removed=ch;}});
  const statuses=[]; const stop=api.watch('member',()=>called++,s=>statuses.push(s));
  assert.equal(subscriptions.find(x=>x.table==='notifications').filter,'recipient_id=eq.member');
  assert.equal(subscriptions.find(x=>x.table==='room_reads').filter,'user_id=eq.member');
  assert.equal(called,3);assert.deepEqual(statuses,['SUBSCRIBED']);stop();assert.equal(removed,channel);
});
test('reading a notification passes its version and errors remain failures',async()=>{
  const calls=[];const api=createNotificationsApi({rpc:async(name,args)=>{calls.push({name,args});return {error:{code:'offline'}};}});
  await assert.rejects(()=>api.read({id:'notice',version:3}));
  assert.deepEqual(calls[0],{name:'notice_mark_read',args:{notice_id:'notice',expected_version:3}});
  assert.equal(notificationLabel({kind:'dm',name:'Student',body:'never include this'}),'Student sent you a private message');
});
test('post notification deep links load a specific post after refresh',()=>{
  const post='30000000-0000-4000-8000-000000000001';
  const url=roomUrl('study-lounge','posts',new URL('https://www.interoom.org/'),true,null,post);
  assert.deepEqual(currentRoute(new URL(url)),{roomId:'study-lounge',view:'posts',postId:post});
  assert.equal(currentRoute(new URL('https://www.interoom.org/?post=invalid')).postId,undefined);
});

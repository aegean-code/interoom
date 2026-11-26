import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, createMessagingApi } from '../src/messaging-api.js';
import { currentRoute, roomUrl } from '../src/routing.js';

test('late Realtime inserts and refreshes cannot duplicate or resurrect a deleted message', () => {
  const initial=[{id:'a',sequence:1,body:'hello'},{id:'b',sequence:2,body:'two'}];
  const removed=mergeMessages(initial,[{id:'a',sequence:1,body:null,deleted_at:'2026-11-22'}]);
  const late=mergeMessages(removed,[initial[0],{id:'c',sequence:3,body:'three'},initial[1]]);
  assert.deepEqual(late.map(m=>m.id),['a','b','c']);
  assert.equal(late[0].body,null);
});

test('message deep links survive refresh and leave room subdomains safely',()=>{
  const id='10000000-0000-4000-8000-000000000001';
  const url=roomUrl(null,'messages',new URL('https://study.interoom.org'),true,id);
  assert.equal(url,`https://www.interoom.org/?view=messages&conversation=${id}`);
  assert.deepEqual(currentRoute(new URL(url)),{roomId:null,view:'messages',conversationId:id});
  assert.equal(currentRoute(new URL('https://interoom.org/?view=messages&conversation=bad')).conversationId,null);
});

test('RPC failures remain failures, and retry uses the same supplied nonce',async()=>{
  const calls=[];
  const client={rpc:async(name,args)=>{calls.push({name,args});return calls.length===1?{error:{code:'network'}}:{data:[{id:'message',body:args.message_body}]};}};
  const api=createMessagingApi(client);
  await assert.rejects(()=>api.send('conversation','hello','nonce'));
  const retry=await api.send('conversation','hello','nonce');
  assert.deepEqual(calls[0],calls[1]);assert.equal(retry.id,'message');
});

test('Realtime subscription handles messages and read receipts and is removed on sign-out',()=>{
  const events=[];let subscription,removed;
  const channel={on:(kind,filter,cb)=>{events.push({kind,filter,cb});return channel;},subscribe:cb=>{subscription=cb;return channel;}};
  const client={channel:()=>channel,removeChannel:value=>{removed=value;}};
  const observed=[],statuses=[];
  const stop=createMessagingApi(client).watch('member',e=>observed.push(e),s=>statuses.push(s));
  subscription('SUBSCRIBED');
  events.find(e=>e.filter.table==='dm_reads').cb({eventType:'INSERT',new:{last_read_sequence:5}});
  assert.equal(observed[0].table,'dm_reads');assert.deepEqual(statuses,['SUBSCRIBED']);
  stop();assert.equal(removed,channel);
});

// Local-only verification harness. Never uses Supabase accounts or API credentials.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PGlite} from '@electric-sql/pglite';
import {MessagesPage,useMessaging} from '../../src/messaging';
import {createMessagingApi} from '../../src/messaging-api';
import '../../src/style.css';
import base from '../../supabase/migrations/20261113000000_create_community.sql?raw';
import roles from '../../supabase/migrations/20261119000000_school_ambassadors.sql?raw';
import admin from '../../supabase/migrations/20261121000000_admin_member_directory.sql?raw';
import dm from '../../supabase/migrations/20261121180814_private_messaging.sql?raw';
document.getElementById('root').textContent='Starting isolated messaging database…';
const asset='/node_modules/@electric-sql/pglite/dist/';
const db=new PGlite({dataDir:'idb://interoom-messaging-qa-1',fsBundle:await (await fetch(asset+'pglite.data')).blob(),pgliteWasmModule:await WebAssembly.compile(await (await fetch(asset+'pglite.wasm')).arrayBuffer()),initdbWasmModule:await WebAssembly.compile(await (await fetch(asset+'initdb.wasm')).arrayBuffer())});
const ids=['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'];
await db.waitReady;
if(!(await db.query("select to_regclass('public.profiles') as exists")).rows[0].exists){
 await db.exec(`create role anon;create role authenticated;create schema auth;grant usage on schema auth to anon,authenticated;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,created_at timestamptz default now(),deleted_at timestamptz,is_anonymous boolean default false);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create publication supabase_realtime;`);
 for(const migration of [base,roles,admin,dm])await db.exec(migration);
 for(let i=0;i<2;i++){await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[ids[i],`local${i}@example.invalid`]);await db.query('insert into public.profiles(id,name,username) values($1,$2,$3)',[ids[i],i?'Local Student Two':'Local Student One',i?'local_two':'local_one']);}
}
let queue=Promise.resolve();const listeners=new Set();
const tables={dm_start_conversation:'dm_conversations',dm_send_message:'dm_messages',dm_mark_read:'dm_reads',dm_delete_message:'dm_messages',dm_set_block:'dm_conversations',dm_set_preferences:'dm_presence'};
function client(user){return {
 rpc(name,args={}){
  const run=queue.then(async()=>{
   try{
    await db.exec('begin;set local role authenticated;');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    const keys=Object.keys(args);const sql=`select to_jsonb(value) as value from public.${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')}) value`;
    const r=await db.query(sql,Object.values(args));await db.exec('commit');
    const data=name==='dm_get_messages'?r.rows.map(r=>r.value):r.rows[0]?.value;
    let payload=name==='dm_send_message'?data:{};
    if(name==='dm_delete_message')payload=(await db.query('select * from public.dm_messages where id=$1',[args.message_id])).rows[0];
    if(tables[name]) for(const l of listeners) if(l.table===tables[name]) l.callback({eventType:'UPDATE',new:payload});
    return {data,error:null};
   }catch(e){await db.exec('rollback');return {data:null,error:{code:e.code,message:e.message}};}
  });queue=run.then(()=>{});return run;
 },
 channel(){const own=[];const channel={on(kind,filter,callback){const l={table:filter.table,callback};listeners.add(l);own.push(l);return channel;},subscribe(callback){queueMicrotask(()=>callback('SUBSCRIBED'));return channel;},stop(){own.forEach(l=>listeners.delete(l));}};return channel;},
 removeChannel(channel){channel.stop();}
};}
const apis=ids.map(id=>createMessagingApi(client(id)));
function Account({index}){const [selected,setSelected]=useState(null);const inbox=useMessaging(ids[index],apis[index]);return <section aria-label={`Local account ${index?'B':'A'}`} style={{minWidth:0,padding:20,border:'1px solid #ccc'}}><p>Isolated account {index?'B':'A'}</p><MessagesPage userId={ids[index]} eligible inbox={inbox} conversationId={selected} openConversation={setSelected} signIn={()=>{}} api={apis[index]}/></section>;}
function QA(){const[mode,setMode]=useState(new URLSearchParams(location.search).get('layout') || 'both');return <><p style={{padding:15}}>Isolated local database — no production users. Live Supabase Realtime still needs verification.</p><label>Test layout <select value={mode} onChange={e=>setMode(e.target.value)}><option value="both">Both accounts</option><option value="a">Account A</option><option value="b">Account B</option></select></label><div style={{display:'grid',gridTemplateColumns:mode==='both'?'repeat(2,minmax(0,1fr))':'1fr',gap:12}}>{mode!=='b'&&<Account key="a" index={0}/>} {mode!=='a'&&<Account key="b" index={1}/>}</div></>;}
createRoot(document.getElementById('root')).render(<QA/>);

import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoute, isInteroomHost, roomUrl } from '../src/routing.js';

test('each room resolves from its subdomain', () => {
  for (const [host,id] of [['general','general'],['study','study-lounge'],['careers','university-careers'],['abroad','life-abroad'],['culture','culture-exchange']]) {
    assert.deepEqual(currentRoute(new URL(`https://${host}.interoom.org/`)), {roomId:id,view:'chat'});
  }
});
test('preview links keep a single origin and preserve rooms across reloads', () => {
 const location=new URL('https://preview.vercel.app/');
 const url=roomUrl('study-lounge','chat',location,true);
 assert.equal(new URL(url).origin,location.origin);
 assert.deepEqual(currentRoute(new URL(url)),{roomId:'study-lounge',view:'chat'});
});
test('production subdomains are enabled only after provisioning', () => {
 const location=new URL('https://www.interoom.org/');
 assert.equal(roomUrl('study-lounge','chat',location,true),'https://study.interoom.org/?view=chat');
 assert.equal(roomUrl('study-lounge','posts',location,true),'https://study.interoom.org/?view=posts');
 assert.equal(new URL(roomUrl('study-lounge','chat',location,false)).hostname,location.hostname);
 assert.equal(isInteroomHost('interoom.org.evil.example'),false);
 assert.equal(isInteroomHost('untrusted.interoom.org'),false);
 assert.equal(currentRoute(new URL('https://preview.vercel.app/?room=__proto__')).roomId,null);
});

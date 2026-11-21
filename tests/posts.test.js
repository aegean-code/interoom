import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { loadPosts } from '../src/posts.js';

function fixture(respond) {
  const requests = [];
  const client = createClient('https://test.example', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(input);
      requests.push(url);
      assert.equal(init.method, 'GET');
      return respond(url);
    } },
  });
  return { client, requests };
}

for (const roomId of [null, 'study-lounge']) {
  test(`feed loads authors, counts and my reactions for ${roomId ?? 'all rooms'}`, async () => {
    const author = { name: 'Test author', country: 'Test country', ambassadors: { school: 'Test school' } };
    const { client, requests } = fixture(url => {
      if (url.pathname === '/rest/v1/posts') {
        const select = url.searchParams.get('select');
        // Regression for the production PGRST201: the unqualified profiles
        // relation also matches the many-to-many path through reactions.
        if (!select.includes('profile:profiles!posts_author_id_fkey(')) {
          return Response.json({ code: 'PGRST201', message: 'Ambiguous profiles relationship' }, { status: 300 });
        }
        assert.ok(select.includes('ambassadors(school)'));
        assert.ok(select.includes('replies(count),reactions(count)'));
        assert.equal(url.searchParams.get('room_id'), roomId ? `eq.${roomId}` : null);
        assert.equal(url.searchParams.get('order'), 'created_at.desc');
        assert.equal(url.searchParams.get('limit'), '60');
        return Response.json([
          { id: 'post-a', profile: author, replies: [{ count: 2 }], reactions: [{ count: 3 }] },
          { id: 'post-b', profile: null, replies: [], reactions: [{ count: 0 }] },
        ]);
      }
      assert.equal(url.pathname, '/rest/v1/reactions');
      assert.equal(url.searchParams.get('author_id'), 'eq.current-user');
      assert.equal(url.searchParams.get('post_id'), 'in.(post-a,post-b)');
      return Response.json([{ post_id: 'post-a' }]);
    });
    const posts = await loadPosts(client, roomId, 'current-user');
    assert.equal(requests.length, 2);
    assert.deepEqual(posts.map(({ profile, liked, replyCount, reactionCount }) => ({ profile, liked, replyCount, reactionCount })), [
      { profile: author, liked: true, replyCount: 2, reactionCount: 3 },
      { profile: null, liked: false, replyCount: 0, reactionCount: 0 },
    ]);
  });
}

test('empty feed does not make an invalid empty reactions request', async () => {
  const { client, requests } = fixture(() => Response.json([]));
  assert.deepEqual(await loadPosts(client, 'general', 'current-user'), []);
  assert.equal(requests.length, 1);
});

test('feed errors remain errors instead of looking like an empty community', async () => {
  const { client, requests } = fixture(() => Response.json({ code: '42501', message: 'Permission denied' }, { status: 403 }));
  await assert.rejects(loadPosts(client, null, 'current-user'), error => error.code === '42501');
  assert.equal(requests.length, 1);
});

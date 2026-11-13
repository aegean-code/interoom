import { createBrowserClient } from '@supabase/ssr';
import { isInteroomHost } from './routing';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase = url && key ? createBrowserClient(url, key, {
  cookieOptions: {
    path: '/', sameSite: 'lax', secure: window.location.protocol === 'https:',
    ...(isInteroomHost(window.location.hostname) ? { domain: '.interoom.org' } : {}),
  },
}) : null;
const authors = 'profile:profiles(name,country)';
const feedFields = `id,room_id,author_id,body,created_at,${authors},replies(count),reactions(count)`;
async function data(result) {
  if (result.error) throw result.error;
  return result.data;
}
export async function getProfile(id) {
  return data(await supabase.from('profiles').select('name,country').eq('id', id).maybeSingle());
}
export async function saveProfile(id, profile, exists) {
  if (exists) return data(await supabase.from('profiles').update(profile).eq('id', id));
  return data(await supabase.from('profiles').insert({ id, ...profile }));
}
export async function getPosts(roomId, userId) {
  let query = supabase.from('posts').select(feedFields).order('created_at', { ascending: false }).limit(60);
  if (roomId) query = query.eq('room_id', roomId);
  const posts = await data(await query);
  if (!posts.length) return [];
  const reactions = await data(await supabase.from('reactions').select('post_id').eq('author_id', userId).in('post_id', posts.map(p => p.id)));
  const liked = new Set(reactions.map(r => r.post_id));
  return posts.map(p => ({ ...p, liked: liked.has(p.id), reactionCount: p.reactions[0]?.count ?? 0, replyCount: p.replies[0]?.count ?? 0 }));
}
export async function getReplies(postId) {
  return data(await supabase.from('replies').select(`id,author_id,body,created_at,${authors}`).eq('post_id', postId).order('created_at').limit(100));
}
export async function getMessages(roomId) {
  const messages = await data(await supabase.from('messages').select(`id,author_id,body,created_at,${authors}`).eq('room_id', roomId).order('created_at', { ascending: false }).limit(100));
  return messages.reverse();
}
export async function addEntry(table, fields) {
  return data(await supabase.from(table).insert(fields));
}
export async function deleteEntry(table, id) {
  return data(await supabase.from(table).delete().eq('id', id));
}
export async function setReaction(post, userId) {
  if (post.liked) return data(await supabase.from('reactions').delete().eq('post_id', post.id).eq('author_id', userId));
  const result = await supabase.from('reactions').insert({ post_id: post.id });
  if (result.error?.code !== '23505') return data(result);
}
export async function reportEntry(kind, id, reason) {
  const result = await supabase.from('reports').insert({ target_kind: kind, target_id: id, reason });
  if (result.error?.code !== '23505') return data(result);
}

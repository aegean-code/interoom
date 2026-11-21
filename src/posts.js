// Reactions also connect posts to profiles. Select the author foreign key
// explicitly so PostgREST does not confuse authors with people who reacted.
const feedFields = 'id,room_id,author_id,body,created_at,profile:profiles!posts_author_id_fkey(name,country,ambassadors(school)),replies(count),reactions(count)';

export async function loadPosts(client, roomId, userId) {
  let query = client.from('posts').select(feedFields).order('created_at', { ascending: false }).limit(60);
  if (roomId) query = query.eq('room_id', roomId);
  const { data: posts, error } = await query;
  if (error) throw error;
  if (!posts.length) return [];
  const { data: reactions, error: reactionError } = await client.from('reactions').select('post_id').eq('author_id', userId).in('post_id', posts.map(p => p.id));
  if (reactionError) throw reactionError;
  const liked = new Set(reactions.map(r => r.post_id));
  return posts.map(p => ({ ...p, liked: liked.has(p.id), reactionCount: p.reactions[0]?.count ?? 0, replyCount: p.replies[0]?.count ?? 0 }));
}

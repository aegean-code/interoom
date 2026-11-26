import { roomById } from './rooms.js';

export const roomHosts = {
  general: 'general',
  'study-lounge': 'study',
  'university-careers': 'careers',
  'life-abroad': 'abroad',
  'culture-exchange': 'culture',
};
export const rootDomain = 'interoom.org';
export function isInteroomHost(host) {
  return host === rootDomain || host === `www.${rootDomain}` ||
    Object.values(roomHosts).some(prefix => host === `${prefix}.${rootDomain}`);
}
export function currentRoute(location) {
  const room = Object.entries(roomHosts).find(([, host]) => location.hostname === `${host}.${rootDomain}`)?.[0];
  const query = new URLSearchParams(location.search);
  const requestedRoom = query.get('room');
  if (query.get('view') === 'messages') return { roomId: null, view: 'messages', conversationId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.get('conversation') || '') ? query.get('conversation') : null };
  if (['ambassadors', 'admin', 'members'].includes(query.get('view'))) return { roomId: null, view: query.get('view') };
  return {
    roomId: room || (Object.hasOwn(roomById, requestedRoom) ? requestedRoom : null),
    view: query.get('view') === 'chat' || (room && !query.has('view')) ? 'chat' : 'posts',
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.get('post') || '') ? { postId: query.get('post') } : {}),
  };
}
export function roomUrl(roomId, view, location, subdomainsEnabled, conversationId = null, postId = null) {
  const params = new URLSearchParams();
  if (['chat', 'ambassadors', 'admin', 'messages', 'members'].includes(view)) params.set('view', view);
  if (view === 'messages' && conversationId) params.set('conversation', conversationId);
  if (view === 'posts' && postId) { params.set('view', 'posts'); params.set('post', postId); }
  const production = isInteroomHost(location.hostname) && subdomainsEnabled;
  if (!production && roomId) params.set('room', roomId);
  const origin = production
    ? `https://${roomId ? roomHosts[roomId] : 'www'}.${rootDomain}`
    : location.origin;
  if (production && roomId && view === 'posts') params.set('view', 'posts');
  return `${origin}/${params.size ? '?' + params : ''}`;
}

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
  return {
    roomId: room || (Object.hasOwn(roomById, requestedRoom) ? requestedRoom : null),
    view: query.get('view') === 'chat' || (room && !query.has('view')) ? 'chat' : 'posts',
  };
}
export function roomUrl(roomId, view, location, subdomainsEnabled) {
  const params = new URLSearchParams();
  if (view === 'chat') params.set('view', 'chat');
  const production = isInteroomHost(location.hostname) && subdomainsEnabled;
  if (!production && roomId) params.set('room', roomId);
  const origin = production
    ? `https://${roomId ? roomHosts[roomId] : 'www'}.${rootDomain}`
    : location.origin;
  if (production && roomId && view === 'posts') params.set('view', 'posts');
  return `${origin}/${params.size ? '?' + params : ''}`;
}

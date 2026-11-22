import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, X } from 'lucide-react';
import { supabase } from './community';
import { UnreadBadge } from './messaging';
import { createNotificationsApi, notificationLabel } from './notifications-api';
import './notifications.css';

export const notificationsApi = createNotificationsApi(supabase);
const empty = { items: [], rooms: [], unread_count: 0, total: 0, loading: true };
const failure = 'Couldn’t load notifications. Check your connection and try again.';
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function useNotifications(userId, api = notificationsApi) {
  const [state, setState] = useState(empty);
  const [connected, setConnected] = useState(false);
  const request = useRef(0), pages = useRef(1), loadingMore = useRef(false);
  const refresh = useCallback(async () => {
    if (!userId) return;
    const version = ++request.current;
    try {
      const [batches, rooms] = await Promise.all([
        Promise.all(Array.from({ length: pages.current }, (_, page) => api.list(page))), api.rooms(),
      ]);
      if (version !== request.current) return;
      setState({ ...batches[0], owner: userId, rooms, loading: false,
        items: [...new Map(batches.flatMap(batch => batch.items).map(item => [item.id, item])).values()] });
    } catch {
      if (version === request.current) setState(old => ({ ...(old.owner === userId ? old : empty), owner: userId, loading: false, error: failure }));
    }
  }, [userId, api]);
  useEffect(() => {
    pages.current = 1; setState({ ...empty, owner: userId, loading: Boolean(userId) }); setConnected(false);
    if (!userId) return;
    let debounce;
    const changed = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 150); };
    const stop = api.watch(userId, changed, status => { setConnected(status === 'SUBSCRIBED'); if (status === 'SUBSCRIBED') refresh(); });
    const recover = () => { if (!document.hidden) refresh(); };
    refresh(); const timer = setInterval(recover, 30_000);
    window.addEventListener('focus', recover); document.addEventListener('visibilitychange', recover);
    return () => { request.current++; stop(); clearTimeout(debounce); clearInterval(timer); window.removeEventListener('focus', recover); document.removeEventListener('visibilitychange', recover); };
  }, [userId, api, refresh]);
  const readRoom = useCallback(async (room, view, entry) => {
    if (!userId || !room || !entry) return;
    await api.readRoom(room, view, entry); await refresh();
  }, [userId, api, refresh]);
  const visible = state.owner === userId ? state : { ...empty, loading: Boolean(userId) };
  return { ...visible, connected, refresh, readRoom,
    read: async item => { await api.read(item); await refresh(); },
    readAll: async () => { await api.readAll(visible.snapshot_at); await refresh(); },
    loadMore: async () => { if (loadingMore.current) return; loadingMore.current = true; pages.current++; try { await refresh(); } finally { loadingMore.current = false; } },
  };
}

// Reading a room only advances through content actually loaded into its view.
export function useRoomReadMarker(room, view, entry, markRead) {
  useEffect(() => {
    if (!room || !entry || !markRead) return;
    const mark = () => { if (!document.hidden && document.hasFocus()) markRead(room, view, entry).catch(() => {}); };
    mark(); window.addEventListener('focus', mark); document.addEventListener('visibilitychange', mark);
    return () => { window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark); };
  }, [room, view, entry, markRead]);
}

export function NotificationBell({ notifications, onOpen }) {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const root = useRef(null), trigger = useRef(null), closeButton = useRef(null);
  function close() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const outside = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    const key = e => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  async function run(action) { setPending(true); setError(''); try { await action(); } catch { setError('Couldn’t update notifications. Please try again.'); } finally { setPending(false); } }
  return <div className="notification-root" ref={root}>
    <button ref={trigger} className="icon-button notification-toggle" aria-label={`Notifications${notifications.unread_count ? `, ${notifications.unread_count} unread` : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen(!open); if (!open) notifications.refresh(); }}><Bell size={20} /><UnreadBadge count={notifications.unread_count} label="unread notifications" /></button>
    {open && <section className="notification-center" role="dialog" aria-label="Notifications">
      <header><h2>Notifications</h2><button ref={closeButton} className="icon-button" aria-label="Close notifications" onClick={close}><X size={18} /></button></header>
      <div className="notification-toolbar"><span role="status">{notifications.connected ? 'Up to date' : 'Reconnecting…'}</span><button className="text-button" disabled={pending || !notifications.unread_count || !notifications.snapshot_at} onClick={() => run(notifications.readAll)}>Mark all as read</button></div>
      {notifications.loading && <p className="state" role="status">Loading notifications…</p>}
      {(notifications.error || error) && <p className="error notification-status" role="alert">{error || notifications.error} <button className="text-button" onClick={notifications.refresh}>Retry</button></p>}
      {!notifications.loading && !notifications.error && !notifications.items.length && <div className="notification-empty"><Bell size={28} /><h3>You’re all caught up.</h3><p>Replies, mentions, reactions and private messages will appear here.</p></div>}
      <ul className="notification-list">{notifications.items.map(item => <li key={item.id} className={!item.read_at && !item.unavailable ? 'notification-unread' : ''}>
        <button className="notification-item" disabled={pending || item.unavailable} onClick={() => run(async () => { await notifications.read(item); close(); onOpen(item); })}>
          <span className="dm-avatar" aria-hidden="true">{(item.name || 'Member').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('')}</span>
          <span><strong>{notificationLabel(item)}</strong><time dateTime={item.updated_at}>{date.format(new Date(item.updated_at))}</time>{item.unavailable && <small>This activity is no longer available.</small>}{!item.read_at && !item.unavailable && <span className="sr-only">Unread</span>}</span>
        </button>
        {!item.read_at && !item.unavailable && <button className="icon-button" aria-label={`Mark notification from ${item.name || 'member'} as read`} disabled={pending} onClick={() => run(() => notifications.read(item))}><Check size={17} /></button>}
      </li>)}</ul>
      {notifications.items.length < notifications.total && <button className="text-button notification-more" disabled={pending} onClick={() => run(notifications.loadMore)}>Older notifications</button>}
    </section>}
  </div>;
}

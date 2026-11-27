import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, Flag, MessageCircle, Plus, Search, Send, Settings, Shield, Trash2, X } from 'lucide-react';
import { supabase } from './community';
import { createMessagingApi, mergeMessages, messagingError } from './messaging-api';
import { Avatar } from './avatar';
import './messaging.css';

export const messagingApi = createMessagingApi(supabase);
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const formatDate = value => value ? date.format(new Date(value)) : '';

export function UnreadBadge({ count, label = 'unread messages' }) {
  return count > 0 ? <span className="unread-badge" aria-label={`${count} ${label}`}>{count > 99 ? '99+' : count}</span> : null;
}

function MemberAvatar({ person }) {
  return <Avatar name={person?.name} userId={person?.peer_id || person?.id} path={person?.avatar_path} className="dm-avatar" />;
}

export function useMessaging(userId, api = messagingApi) {
  const [state, setState] = useState({ owner: null, loading: true, items: [], unread_count: 0 });
  const [messageEvent, setMessageEvent] = useState(null);
  const [connected, setConnected] = useState(false);
  const pages = useRef(1);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!userId) return;
    const version = ++request.current;
    try {
      const batches = await Promise.all(Array.from({ length: pages.current }, (_, page) => api.inbox(page)));
      const items = [...new Map(batches.flatMap(batch => batch.items).map(item => [item.id, item])).values()];
      if (request.current === version) setState({ ...batches[0], owner: userId, items, loading: false });
    } catch (error) {
      if (request.current === version) setState(old => ({ ...(old.owner === userId ? old : { items: [], unread_count: 0 }), owner: userId, loading: false, error: messagingError(error) }));
    }
  }, [userId, api]);

  useEffect(() => {
    pages.current = 1;
    setState({ owner: userId, loading: Boolean(userId), items: [], unread_count: 0 });
    setConnected(false); setMessageEvent(null);
    if (!userId) return;
    let debounce;
    const unsubscribe = api.watch(userId, event => {
      if (event.table === 'dm_messages' && event.new?.id) setMessageEvent(event.new);
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 150);
    }, status => { setConnected(status === 'SUBSCRIBED'); if (status === 'SUBSCRIBED') refresh(); });
    refresh();
    const recover = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(recover, 30_000);
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      request.current++; unsubscribe(); clearTimeout(debounce); clearInterval(timer);
      window.removeEventListener('focus', recover); document.removeEventListener('visibilitychange', recover);
    };
  }, [userId, api, refresh]);

  useEffect(() => {
    if (!userId || state.owner !== userId || !state.preferences?.show_online) return;
    const heartbeat = () => { if (!document.hidden) api.heartbeat().catch(() => {}); };
    heartbeat(); const timer = setInterval(heartbeat, 45_000);
    document.addEventListener('visibilitychange', heartbeat);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', heartbeat); };
  }, [userId, state.owner, state.preferences?.show_online, api]);

  const visible = state.owner === userId ? state : { items: [], unread_count: 0, loading: Boolean(userId) };
  return { ...visible, connected, messageEvent, refresh, loadMore: async () => { pages.current++; await refresh(); } };
}

function MemberSearch({ api, onStarted, close }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function search(event) {
    event.preventDefault(); setPending(true); setError('');
    try { setResults(await api.search(text.trim())); } catch (e) { setError(messagingError(e)); }
    finally { setPending(false); }
  }
  async function start(person) {
    setPending(true); setError('');
    try { await onStarted(await api.start(person.id)); close(); }
    catch (e) { setError(messagingError(e)); } finally { setPending(false); }
  }
  return <section className="dm-search-panel" aria-label="Find someone to message">
    <div className="dm-section-heading"><h2>New message</h2><button className="icon-button" aria-label="Close member search" onClick={close}><X size={18} /></button></div>
    <form onSubmit={search}><label>Find a member<input autoFocus type="search" minLength={2} maxLength={80} required value={text} placeholder="Name or @username" onChange={e => setText(e.target.value)} /></label><button className="primary" disabled={pending || text.trim().length < 2}><Search size={16} />Search</button></form>
    {error && <p className="error" role="alert">{error}</p>}
    {results?.length === 0 && <p className="dm-hint">No members found. Try another name.</p>}
    {results?.map(person => <button key={person.id} className="dm-person" disabled={pending} onClick={() => start(person)}><MemberAvatar person={person} /><span><strong>{person.name}</strong>{person.username && <small>@{person.username}</small>}</span><MessageCircle size={18} /></button>)}
    <p className="dm-hint">Search uses display names and usernames. Email addresses stay private.</p>
  </section>;
}

function MessagingSettings({ api, values, refresh, close }) {
  const [allowNew, setAllowNew] = useState(values?.allow_new ?? true);
  const [online, setOnline] = useState(values?.show_online ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <form className="dm-settings" onSubmit={async e => {
    e.preventDefault(); setPending(true); setError('');
    try { await api.preferences(allowNew, online); await refresh(); close(); } catch (err) { setError(messagingError(err)); } finally { setPending(false); }
  }}><div className="dm-section-heading"><h2>Messaging privacy</h2><button type="button" className="icon-button" aria-label="Close messaging settings" onClick={close}><X size={18} /></button></div>
    <label className="dm-checkbox"><input type="checkbox" checked={allowNew} onChange={e => setAllowNew(e.target.checked)} />Allow members to start conversations with me</label>
    <p className="dm-hint">Existing conversations remain available. Block a person to stop messages from them.</p>
    <label className="dm-checkbox"><input type="checkbox" checked={online} onChange={e => setOnline(e.target.checked)} />Share my online status with people I message</label>
    <p className="dm-hint">Off by default. No location or last-seen time is shared. Online status may take up to 90 seconds to change.</p>
    {error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={pending}>{pending ? 'Saving…' : 'Save preferences'}</button>
  </form>;
}

function MessageActions({ message, own, api, onChanged }) {
  const [mode, setMode] = useState(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  if (message.deleted_at) return null;
  async function submit(event) {
    event.preventDefault(); setPending(true); setError('');
    try {
      if (own) await api.remove(message.id); else await api.report(message.id, reason.trim());
      setMode(null); setSent(!own); await onChanged(own ? { ...message, body: null, deleted_at: new Date().toISOString() } : null);
    } catch (e) { setError(messagingError(e)); } finally { setPending(false); }
  }
  return <div className="dm-message-actions">
    {!mode && !sent && <button className="icon-button" aria-label={own ? 'Delete message' : 'Report message'} onClick={() => setMode(own ? 'delete' : 'report')}>{own ? <Trash2 size={14} /> : <Flag size={14} />}</button>}
    {sent && <span role="status">Report sent</span>}
    {mode && <form className="dm-action-confirm" onSubmit={submit}>
      {own ? <p>Delete this message for both people?</p> : <><label>Report reason<textarea required minLength={2} maxLength={500} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label><p>Only this message and your reason will be shared with moderators.</p></>}
      <button className="text-button" disabled={pending}>{pending ? 'Please wait…' : own ? 'Confirm deletion' : 'Send report'}</button><button type="button" className="text-button" disabled={pending} onClick={() => setMode(null)}>Cancel</button>
    </form>}{error && <p className="error" role="alert">{error}</p>}
  </div>;
}

function Conversation({ conversationId, person: inboxPerson, userId, api, inbox, back }) {
  const [resolvedPerson, setResolvedPerson] = useState(null);
  const person = inboxPerson || resolvedPerson;
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderPending, setOlderPending] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [blockConfirm, setBlockConfirm] = useState(false);
  const [blockPending, setBlockPending] = useState(false);
  const [visible, setVisible] = useState(!document.hidden && document.hasFocus());
  const log = useRef(null), anchor = useRef(null), forceScroll = useRef(false), nonce = useRef(null), busy = useRef(false), lastRead = useRef(null);
  const request = useRef(0);
  const firstPage = useRef(true);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const [rows, details] = await Promise.all([api.messages(conversationId), api.conversation(conversationId)]);
      if (version !== request.current) return;
      if (!details) { setError('This conversation is unavailable. Return to your inbox.'); setLoading(false); return; }
      setResolvedPerson(details);
      setMessages(old => mergeMessages(old, rows));
      if (firstPage.current) { setHasOlder(rows.length === 50); firstPage.current = false; }
      setError(''); setLoading(false);
    } catch (e) { if (version === request.current) { setError(messagingError(e)); setLoading(false); } }
  }, [api, conversationId]);
  useEffect(() => { if (!inboxPerson) refresh(); }, [inbox.items, inboxPerson, refresh]);
  // Recover all rows when several Realtime events arrive in a single render.
  useEffect(() => { if (inboxPerson?.last_message) refresh(); }, [inboxPerson?.last_message?.id, inboxPerson?.last_message?.deleted_at, refresh]);
  useEffect(() => {
    refresh();
    const resume = () => { const active = !document.hidden && document.hasFocus(); setVisible(active); if (active) refresh(); };
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
    window.addEventListener('focus', resume); window.addEventListener('blur', resume); document.addEventListener('visibilitychange', resume);
    return () => { request.current++; clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('blur', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);
  useEffect(() => {
    const event = inbox.messageEvent;
    if (event?.conversation_id === conversationId) setMessages(old => mergeMessages(old, [event]));
  }, [inbox.messageEvent, conversationId]);
  const latest = messages.at(-1);
  useLayoutEffect(() => {
    if (!log.current) return;
    if (anchor.current !== null) { log.current.scrollTop += log.current.scrollHeight - anchor.current; anchor.current = null; }
    else if (nearBottom || forceScroll.current) { log.current.scrollTop = log.current.scrollHeight; forceScroll.current = false; }
  }, [messages, nearBottom]);
  useEffect(() => {
    if (!visible || !nearBottom || !latest || loading || lastRead.current === latest.id) return;
    let active = true;
    api.read(conversationId, latest.id).then(() => { if (active) { lastRead.current = latest.id; inbox.refresh(); } }).catch(() => {});
    return () => { active = false; };
  }, [visible, nearBottom, latest?.id, loading, conversationId, api, inbox.refresh]);

  async function older() {
    setOlderPending(true);
    try { const rows = await api.messages(conversationId, messages[0]?.sequence); anchor.current = log.current?.scrollHeight ?? null; setMessages(old => mergeMessages(old, rows)); setHasOlder(rows.length === 50); }
    catch (e) { setError(messagingError(e)); } finally { setOlderPending(false); }
  }
  async function send(event) {
    event.preventDefault(); if (busy.current || !draft.trim()) return;
    busy.current = true; setSending(true); setError('');
    const body = draft.trim();
    if (!nonce.current || nonce.current.body !== body) nonce.current = { body, id: crypto.randomUUID() };
    try {
      const row = await api.send(conversationId, body, nonce.current.id);
      forceScroll.current = true; setNearBottom(true); setMessages(old => mergeMessages(old, [row])); setDraft(''); nonce.current = null; await inbox.refresh();
    } catch (e) { setError(messagingError(e)); } finally { busy.current = false; setSending(false); }
  }
  async function toggleBlock() {
    setBlockPending(true); setError('');
    try { await api.block(person.peer_id, !person.blocked_by_me); setBlockConfirm(false); await Promise.all([inbox.refresh(), refresh()]); }
    catch (e) { setError(messagingError(e)); } finally { setBlockPending(false); }
  }
  return <section className="dm-thread" aria-label="Private conversation">
    <header className="dm-thread-heading"><button className="icon-button dm-back" aria-label="Back to inbox" onClick={back}><ArrowLeft size={20} /></button><MemberAvatar person={person} /><div><h2>{person?.name || 'Conversation'}</h2>{person?.username && <span>@{person.username}</span>}{person?.is_online !== null && person?.is_online !== undefined && <small className={person.is_online ? 'dm-online' : ''}>{person.is_online ? 'Online' : 'Offline'}</small>}</div>{person && <button className="text-button dm-block" onClick={() => setBlockConfirm(!blockConfirm)}>{person.blocked_by_me ? 'Unblock' : 'Block'}</button>}</header>
    {blockConfirm && <div className="dm-warning"><p>{person.blocked_by_me ? 'Allow messages between you again?' : 'Block this person? Neither of you will be able to send messages. Your history stays available.'}</p><button className="text-button" disabled={blockPending} onClick={toggleBlock}>{person.blocked_by_me ? 'Confirm unblock' : 'Confirm block'}</button><button className="text-button" onClick={() => setBlockConfirm(false)}>Cancel</button></div>}
    <div className="dm-log" ref={log} role="log" aria-label="Private messages" tabIndex={0} onScroll={() => { const el = log.current; setNearBottom(el.scrollHeight - el.clientHeight - el.scrollTop < 70); }}>
      {hasOlder && <button className="text-button dm-load-older" disabled={olderPending} onClick={older}>{olderPending ? 'Loading…' : 'Load earlier messages'}</button>}
      {loading && <p className="state" role="status">Loading your conversation…</p>}
      {!loading && !messages.length && !error && <div className="dm-empty"><MessageCircle size={28} /><h3>Start with a hello.</h3><p>This conversation is just between the two of you.</p></div>}
      {messages.map(message => <article key={message.id} className={`dm-message ${message.sender_id === userId ? 'dm-own' : ''}`}>
        <div className={`dm-bubble ${message.deleted_at ? 'dm-deleted' : ''}`}><p>{message.deleted_at ? 'Message deleted' : message.body}</p></div>
        <div className="dm-message-meta"><time dateTime={message.created_at}>{formatDate(message.created_at)}</time>{message.sender_id === userId && !message.deleted_at && <span aria-label={person?.peer_read_sequence >= message.sequence ? 'Read' : 'Sent'}>{person?.peer_read_sequence >= message.sequence ? <CheckCheck size={15} /> : <Check size={15} />}{person?.peer_read_sequence >= message.sequence ? 'Read' : 'Sent'}</span>}
          <MessageActions message={message} own={message.sender_id === userId} api={api} onChanged={async row => { if (row) setMessages(old => mergeMessages(old, [row])); await inbox.refresh(); }} />
        </div>
      </article>)}
    </div>
    {!nearBottom && messages.length > 0 && <button className="dm-jump" onClick={() => { forceScroll.current = true; setNearBottom(true); }}>Latest messages</button>}
    {error && <p className="error dm-error" role="alert">{error} <button className="text-button" onClick={refresh}>Retry loading</button></p>}
    {person?.can_message === false ? <p className="dm-warning">{person.blocked_by_me ? 'You blocked this person. Unblock them to send messages.' : 'Messaging is unavailable in this conversation.'}</p> : <form className="dm-compose" onSubmit={send}><label className="sr-only" htmlFor={`direct-message-${userId}-${conversationId}`}>Write a private message</label><textarea id={`direct-message-${userId}-${conversationId}`} placeholder="Write a message…" rows={2} maxLength={4000} value={draft} disabled={sending || loading || !person} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(e); } }} /><button className="primary" aria-label="Send private message" disabled={sending || !draft.trim() || !person}><Send size={20} /></button><small>Enter to send · Shift + Enter for a new line</small></form>}
  </section>;
}

export function MessagesPage({ userId, eligible, inbox, conversationId, openConversation, signIn, api = messagingApi }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selected = inbox.items.find(item => item.id === conversationId);
  if (!eligible) return <section id="conversations" className="signin-state"><h1>Private messages</h1><p>{userId ? 'Confirm your email and complete your profile to use private messages.' : 'Sign in to message another student.'}</p><button className="primary" onClick={signIn}>{userId ? 'Your account' : 'Sign in'}</button></section>;
  return <section id="conversations" aria-label="Direct messages" className="dm-page">
    <div className="page-intro"><span className="welcome-eyebrow">A conversation of your own</span><h1>Messages</h1><p>Stay in touch, wherever school takes you.</p></div>
    {settingsOpen && <MessagingSettings api={api} values={inbox.preferences} refresh={inbox.refresh} close={() => setSettingsOpen(false)} />}
    <div className={`dm-layout ${conversationId ? 'dm-has-thread' : ''}`}>
      <aside className="dm-inbox" aria-label="Conversation inbox"><div className="dm-inbox-heading"><h2>Inbox <UnreadBadge count={inbox.unread_count} /></h2><button className="icon-button" aria-label="Messaging privacy settings" onClick={() => setSettingsOpen(!settingsOpen)}><Settings size={18} /></button><button className="icon-button" aria-label="New private message" onClick={() => setSearchOpen(!searchOpen)}><Plus size={22} /></button></div>
        <p className="dm-connection" role="status">{inbox.connected ? 'Connected' : 'Reconnecting · checking for new messages'}</p>
        {searchOpen && <MemberSearch api={api} onStarted={async id => { await inbox.refresh(); openConversation(id); }} close={() => setSearchOpen(false)} />}
        {inbox.loading && <p className="state" role="status">Loading inbox…</p>}
        {inbox.error && <p className="error dm-error" role="alert">{inbox.error} <button className="text-button" onClick={inbox.refresh}>Try again</button></p>}
        {!inbox.loading && !inbox.error && !inbox.items.length && <div className="dm-empty"><MessageCircle size={30} /><h3>Your inbox starts here.</h3><p>Find someone by name and say hello.</p><button className="primary" onClick={() => setSearchOpen(true)}>New message</button></div>}
        <div className="dm-conversation-list">{inbox.items.map(item => <button key={item.id} className={`dm-conversation ${item.id === conversationId ? 'dm-selected' : ''}`} aria-pressed={item.id === conversationId} onClick={() => openConversation(item.id)}><MemberAvatar person={item} /><span className="dm-preview"><strong>{item.name}</strong><small>{item.blocked_by_me ? 'Blocked' : item.last_message?.deleted_at ? 'Message deleted' : item.last_message?.body || 'No messages yet'}</small><time dateTime={item.last_activity_at}>{formatDate(item.last_activity_at)}</time></span><UnreadBadge count={item.unread_count} /></button>)}</div>
        {inbox.items.length < inbox.total && <button className="text-button dm-load-older" onClick={inbox.loadMore}>More conversations</button>}
      </aside>
      {conversationId ? <Conversation key={`${userId}:${conversationId}`} conversationId={conversationId} person={selected} userId={userId} api={api} inbox={inbox} back={() => openConversation(null)} /> : <div className="dm-welcome"><Shield size={36} /><h2>Just the two of you.</h2><p>Choose a conversation or start a new one.</p><small>You can block someone or report a message at any time.</small></div>}
    </div>
  </section>;
}

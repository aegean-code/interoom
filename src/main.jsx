import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, Compass, Flag, GraduationCap, Hash, Heart, ShieldCheck,
  Mail, Menu, MessageCircle, Pause, Play, Plus, Search, Send, Trash2, Users, X,
} from 'lucide-react';
import {
  addEntry, deleteEntry, getAdminStatus, getMessages, getPosts, getProfile, getReplies,
  reportEntry, saveProfile, setReaction, supabase,
} from './community';
import { roomById, rooms } from './rooms';
import { currentRoute, roomUrl } from './routing';
import { AmbassadorBadge, AmbassadorDirectory, AmbassadorAdmin } from './ambassadors';
import { authCallbackFailure, authErrorMessage, cleanAuthCallbackUrl, emailRequests, googleSignInAvailable, googleSignInUrl, initialAuthSession, sendAuthEmail } from './auth';
import { MessagesPage, UnreadBadge, useMessaging } from './messaging';
import { NotificationBell, useNotifications, useRoomReadMarker } from './notifications';
import { MembersPage } from './members';
import './style.css';

const timestamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kinds = { posts: 'post', replies: 'reply', messages: 'message' };

function useResource(load) {
  const [result, setResult] = useState({ load: null });
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const items = await load();
      if (id === request.current) setResult({ load, items });
    } catch {
      if (id === request.current) setResult(previous => ({ ...(previous.load === load ? previous : {}), load, error: true }));
    }
  }, [load]);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      request.current++;
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  return { ...(result.load === load ? result : {}), refresh };
}

function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);

  async function run(action, message = 'Something went wrong. Please try again.') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(typeof message === 'function' ? message(cause) : message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return { pending, error, run, clearError: () => setError('') };
}

function Avatar({ name }) {
  const letters = (name || 'Member').split(/\s+/).slice(0, 2).map(word => word[0]).join('');
  return <span className="avatar" aria-hidden="true">{letters}</span>;
}

function OrbitalGlobe() {
  const [paused, setPaused] = useState(false);
  return <div className={`globe-art ${paused ? 'globe-paused' : ''}`}>
    <div className="globe-illustration" aria-hidden="true">
      <svg className="globe-orbit" viewBox="0 0 220 220">
        <defs><path id="globe-type-path" d="M 110,110 m -98,0 a 98,98 0 1,1 196,0 a 98,98 0 1,1 -196,0" /></defs>
        <text><textPath href="#globe-type-path" textLength="615">INTEROOM · AROUND THE WORLD · INTEROOM · AROUND THE WORLD · </textPath></text>
      </svg>
      <div className="globe-tilt"><div className="globe-sphere">
        <div className="globe-meridians">{[0, 45, 90, 135].map(angle => <span key={angle} style={{ transform: `rotateY(${angle}deg)` }} />)}</div>
        <span className="globe-equator" /><span className="globe-latitude globe-north" /><span className="globe-latitude globe-south" />
      </div></div>
      <svg className="globe-star" viewBox="0 0 32 32"><path d="M16 2v28M2 16h28M6 6l20 20M6 26L26 6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
    </div>
    <button className="globe-toggle" aria-label={paused ? 'Play globe animation' : 'Pause globe animation'} onClick={() => setPaused(value => !value)}>
      {paused ? <Play size={11} /> : <Pause size={11} />} {paused ? 'Play motion' : 'Pause motion'}
    </button>
  </div>;
}

function Status({ resource }) {
  if (resource.error) {
    return <p className="state" role="status">Couldn’t load this. <button className="text-button" onClick={resource.refresh}>Try again</button></p>;
  }
  return resource.items ? null : <p className="state" role="status">Loading…</p>;
}

function Modal({ title, close, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog ref={dialog} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); close(); }}>
      <div className="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="Close" onClick={close}><X size={20} /></button>
      </div>
      {children}
    </dialog>
  );
}

function AuthForm({ userId, profile, metadata, recovery, initialMode = 'login', initialNotice = '', onSaved, onSignOut }) {
  const [mode, setMode] = useState(initialMode);
  const [emailSelected, setEmailSelected] = useState(!['login', 'signup'].includes(initialMode));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [name, setName] = useState((profile?.name ?? metadata?.name ?? metadata?.full_name ?? '').slice(0, 40));
  const [country, setCountry] = useState(profile?.country ?? metadata?.country ?? '');
  const [school, setSchool] = useState(profile?.school ?? metadata?.school ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [sent, setSent] = useState('');
  const [linkError, setLinkError] = useState(initialNotice);
  const [cooldown, setCooldown] = useState(emailRequests.remainingSeconds);
  const [googleEnabled, setGoogleEnabled] = useState(null);
  const { run, pending, error, clearError } = useAction();
  useEffect(() => {
    if (userId || recovery || !supabase) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    googleSignInAvailable(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, { signal: controller.signal })
      .then(enabled => { if (active) setGoogleEnabled(enabled); clearTimeout(timer); });
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [userId, recovery]);
  useEffect(() => {
    const timer = setInterval(() => setCooldown(emailRequests.remainingSeconds()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sendsEmail = !userId && !recovery && ['signup', 'reset', 'verify'].includes(mode);
  if (!supabase) return <p>Account setup is temporarily unavailable.</p>;
  function changeMode(next) {
    if (pending) return;
    setMode(next); setSent(''); setLinkError(''); clearError(); setPassword(''); setPasswordAgain('');
    setCooldown(emailRequests.remainingSeconds());
  }
  function continueWithGoogle() {
    run(async () => {
      setSent(''); setLinkError('');
      window.location.assign(await googleSignInUrl(supabase.auth, window.location.origin));
    }, cause => authErrorMessage(cause, 'google'));
  }
  function submit(event) {
    event.preventDefault();
    run(async () => {
      setSent(''); setLinkError('');
      try {
        if (recovery) {
          if (password !== passwordAgain) throw { code: 'passwords_do_not_match' };
          const result = await supabase.auth.updateUser({ password });
          if (result.error) throw result.error;
          onSaved(profile);
        } else if (userId) {
          const next = { name: name.trim(), country: country.trim(), school: school.trim(), username: username.trim().toLowerCase() || null };
          onSaved(await saveProfile(userId, next, Boolean(profile)));
        } else if (sendsEmail) {
          const result = await sendAuthEmail(supabase.auth, mode, {
            email, password, origin: window.location.origin,
            profile: { name: name.trim(), country: country.trim(), school: school.trim() },
          });
          if (mode === 'reset') setSent('If an account exists for that email, you’ll receive a reset link. Check your inbox and spam folder. Open the newest email in this same browser.');
          else if (mode === 'verify') setSent('If that email has an unconfirmed account, you’ll receive a verification link. Check your inbox and spam folder. Open the newest email in this same browser.');
          else setSent(result.data.session ? 'Account created. Finish setting up your profile.' : 'Check your inbox and spam folder for a verification link. Open the newest email in this same browser. If you already have an account, try signing in or resetting your password.');
        } else {
          const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
          if (result.error) throw result.error;
        }
      } finally { setCooldown(emailRequests.remainingSeconds()); }
    }, cause => authErrorMessage(cause, recovery ? 'password' : userId ? 'profile' : mode));
  }
  if (!userId && !recovery && !emailSelected) return <div className="dialog-form auth-form auth-choice" aria-busy={pending}>
    <div className="auth-welcome">
      <span className="auth-globe-stamp" aria-hidden="true"><img src="/favicon.svg" width="72" height="72" alt="" /></span>
      <span className="auth-eyebrow">A world of shared experiences</span>
      <h3>Make yourself at home.</h3>
      <p>Meet people who know what it’s like to start somewhere new.</p>
    </div>
    {googleEnabled !== false && <button type="button" className="google-sign-in" disabled={pending || !googleEnabled} onClick={continueWithGoogle}>
      <img src="/google-g.png" width="20" height="20" alt="" /><span>{pending ? 'Opening Google…' : 'Continue with Google'}</span>
    </button>}
    {googleEnabled === false ? <p role="status">Google sign-in is temporarily unavailable. You can continue with email.</p> : <div className="auth-divider"><span>or</span></div>}
    <button type="button" className="primary auth-email-choice" disabled={pending} onClick={() => { setEmailSelected(true); clearError(); setLinkError(''); }}>
      <Mail size={19} aria-hidden="true" /> Continue with email <ArrowRight size={17} aria-hidden="true" />
    </button>
    {linkError && <p className="error" role="alert">{linkError}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <p className="auth-choice-footer">{mode === 'signup' ? 'Already part of Interoom?' : 'New to Interoom?'}{' '}
      <button type="button" className="text-button" disabled={pending} onClick={() => { changeMode(mode === 'signup' ? 'login' : 'signup'); setEmailSelected(true); }}>{mode === 'signup' ? 'Sign in' : 'Create an account'}</button>
    </p>
  </div>;
  return <form className="dialog-form auth-form" onSubmit={submit} aria-busy={pending}>
    {!userId && !recovery && <button type="button" className="text-button auth-back" disabled={pending} onClick={() => { setEmailSelected(false); setPassword(''); setPasswordAgain(''); setSent(''); clearError(); setLinkError(''); setMode('login'); }}><ArrowLeft size={15} aria-hidden="true" /> All sign-in options</button>}
    {!userId && !recovery && <div className="view-switch">{[['login', 'Sign in'], ['signup', 'Create account']].map(([value, label]) =>
      <button key={value} type="button" disabled={pending} aria-pressed={mode === value} onClick={() => changeMode(value)}>{label}</button>)}</div>}
    {sent && <p role="status">{sent}</p>}
    {linkError && <p className="error" role="alert">{linkError}</p>}
    {!userId && mode === 'reset' && <p>Enter the email you used to register. We’ll send you a link to choose a new password.</p>}
    {!userId && mode === 'verify' && <p>Enter the email you registered with to request a new verification link.</p>}
    {!userId && !recovery && <label>Email<input type="email" required disabled={pending} autoComplete="email" value={email} onChange={e => { setEmail(e.target.value); setSent(''); clearError(); }} /></label>}
    {(recovery || (!userId && ['login', 'signup'].includes(mode))) && <label>{recovery ? 'New password' : 'Password'}<input type="password" required disabled={pending} minLength={mode === 'login' && !recovery ? 1 : 8} autoComplete={mode === 'login' && !recovery ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>}
    {recovery && <label>Confirm new password<input type="password" required minLength={8} autoComplete="new-password" value={passwordAgain} onChange={e => setPasswordAgain(e.target.value)} /></label>}
    {!recovery && (userId || mode === 'signup') && <>
      <label>Display name<input required minLength={2} maxLength={40} autoComplete="nickname" value={name} onChange={e => setName(e.target.value)} /></label>
      {userId && <label>Username (optional)<input minLength={3} maxLength={24} pattern="[a-z][a-z0-9_]{2,23}" placeholder="your_username" autoCapitalize="none" value={username} onChange={e => setUsername(e.target.value.toLowerCase())} /><small>3–24 letters, numbers or underscores. Start with a letter.</small></label>}
      <label>International school (optional)<input maxLength={120} value={school} onChange={e => setSchool(e.target.value)} /></label>
      <AmbassadorBadge appointment={profile?.ambassadors} />
      <label>Country (optional)<input maxLength={60} value={country} onChange={e => setCountry(e.target.value)} /></label>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {sendsEmail && cooldown > 0 && <p>Another email request will be available in {cooldown}s. Delivery may take longer if the service is busy.</p>}
    <div className="dialog-actions"><button className="primary" disabled={pending || (sendsEmail && cooldown > 0)}>{pending ? 'Please wait…' : recovery ? 'Save new password' : userId ? 'Save profile' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : mode === 'verify' ? 'Resend verification email' : 'Sign in'}</button>
    {userId ? <button type="button" className="text-button" disabled={pending} onClick={() => run(onSignOut)}>Sign out</button> :
      <>
        {mode !== 'reset' && <button type="button" className="text-button" disabled={pending} onClick={() => changeMode('reset')}>Forgot password?</button>}
        {mode !== 'verify' && <button type="button" className="text-button" disabled={pending} onClick={() => changeMode('verify')}>Resend verification email</button>}
      </>}
    </div>
  </form>;
}

function Compose({ selectedRoom, profile, close, onPosted }) {
  const [roomId, setRoomId] = useState(selectedRoom || 'general');
  const [body, setBody] = useState('');
  const { run, pending, error } = useAction();

  return (
    <form className="dialog-form" onSubmit={event => {
      event.preventDefault();
      if (body.trim()) run(async () => {
        await addEntry('posts', { room_id: roomId, body: body.trim() }, profile);
        close();
        onPosted(roomId);
      });
    }}>
      <label>Room<select value={roomId} onChange={event => setRoomId(event.target.value)}>
        {rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
      </select></label>
      <label>Post<textarea required rows={6} maxLength={2000} value={body} onChange={event => setBody(event.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={pending || !body.trim()}>Publish post</button>
    </form>
  );
}

function EntryControls({ entry, table, userId, profile, onDelete, onReport }) {
  const [confirming, setConfirming] = useState(false);
  const { run, pending, error } = useAction();
  const own = profile && entry.author_id === userId;
  if (!own && (!supabase || !profile)) return null;
  const kind = kinds[table];

  return (
    <div className="entry-controls">
      {own ? (
        confirming ? (
          <>
            <button type="button" className="text-button danger" disabled={pending} onClick={() => run(async () => {
              await deleteEntry(table, entry.id);
              await onDelete();
              setConfirming(false);
            })}>Delete {kind}</button>
            <button type="button" className="text-button" disabled={pending} onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="icon-button" aria-label={`Delete ${kind}`} onClick={() => setConfirming(true)}><Trash2 size={15} /></button>
        )
      ) : (
        <button type="button" className="icon-button" aria-label={`Report ${kind}`} onClick={() => onReport({ kind, id: entry.id })}><Flag size={15} /></button>
      )}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

function Author({ entry }) {
  return (
    <div className="author">
      <Avatar name={entry.profile?.name} />
      <div>
        <strong>{entry.profile?.name || 'Member'}</strong>
        <AmbassadorBadge appointment={entry.profile?.ambassadors} />
        <small>
          {[entry.profile?.country, entry.created_at && timestamp.format(new Date(entry.created_at))].filter(Boolean).join(' · ')}
        </small>
      </div>
    </div>
  );
}

function EntryForm({ table, fields, profile, requireProfile, onSent, label }) {
  const [body, setBody] = useState('');
  const { run, pending, error } = useAction();

  return (
    <form className="entry-form" onSubmit={event => {
      event.preventDefault();
      if (!body.trim()) return;
      if (!profile) return requireProfile();
      run(async () => {
        await addEntry(table, { ...fields, body: body.trim() }, profile);
        setBody('');
        await onSent();
      });
    }}>
      <div className="entry-input">
        <textarea aria-label={label} placeholder={label} rows={2} maxLength={1000} value={body} onChange={event => setBody(event.target.value)} />
        <button className="primary" aria-label="Send" disabled={pending || !body.trim()}><Send size={17} /></button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function Replies({ post, refreshPosts, ...actions }) {
  const load = useCallback(() => getReplies(post.id), [post.id]);
  const resource = useResource(load);
  async function refresh() {
    await Promise.all([resource.refresh(), refreshPosts()]);
  }

  return (
    <section className="replies" aria-label="Replies">
      <Status resource={resource} />
      {resource.items?.map(entry => (
        <article className="short-entry" key={entry.id}>
          <div className="entry-head"><Author entry={entry} /><EntryControls entry={entry} table="replies" onDelete={refresh} {...actions} /></div>
          <p>{entry.body}</p>
        </article>
      ))}
      <EntryForm table="replies" fields={{ post_id: post.id }} label="Write a reply" onSent={refresh} {...actions} />
    </section>
  );
}

function Post({ post, refresh, onRoom, initiallyExpanded = false, ...actions }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { run, pending, error } = useAction();

  return (
    <article className="post">
      <div className="entry-head">
        <Author entry={post} />
        <button className="room-tag" onClick={() => onRoom(post.room_id)}><Hash size={14} />{roomById[post.room_id]?.name}</button>
      </div>
      <p className="post-body">{post.body}</p>
      <div className="post-actions">
        <button className={post.liked ? 'liked' : ''} aria-pressed={post.liked} aria-label={post.liked ? 'Remove like' : 'Like post'} disabled={pending} onClick={() => {
          if (!actions.profile) return actions.requireProfile();
          run(async () => { await setReaction(post, actions.userId); await refresh(); });
        }}><Heart size={17} fill={post.liked ? 'currentColor' : 'none'} />{post.reactionCount || 'Like'}</button>
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><MessageCircle size={17} />{post.replyCount ? `${post.replyCount} ${post.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}</button>
        <EntryControls entry={post} table="posts" onDelete={refresh} {...actions} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {expanded && <Replies post={post} refreshPosts={refresh} {...actions} />}
    </article>
  );
}

function Feed({ roomId, query, member, onRoom, postId, markRoomRead, ...actions }) {
  const load = useCallback(() => member ? getPosts(roomId, actions.userId, postId) : Promise.resolve([]), [member, roomId, actions.userId, postId]);
  const resource = useResource(load);
  useRoomReadMarker(!query && !postId ? roomId : null, 'posts', resource.error ? null : resource.items?.[0]?.id, markRoomRead);
  const term = query.trim().toLowerCase();
  const posts = resource.items?.filter(post => [post.body, post.profile?.name, roomById[post.room_id]?.name]
    .some(value => value?.toLowerCase().includes(term)));

  if (!member) return <div className="signin-state"><h3>Join the conversation</h3><p>Sign in to read posts, ask a question, or share something with other students.</p><button className="primary" onClick={actions.requireProfile}>Sign in or create an account <ArrowRight size={15} /></button></div>;

  return (
    <div className="feed">
      <Status resource={resource} />
      {postId && <button className="text-button" onClick={() => onRoom(roomId, 'posts')}>All posts in this room</button>}
      {posts?.length === 0 && <p className="state">{postId ? 'This post is no longer available.' : term ? 'No matching posts.' : 'No posts in this room yet.'}</p>}
      {posts?.map(post => <Post key={post.id} post={post} refresh={resource.refresh} onRoom={onRoom} initiallyExpanded={Boolean(postId)} {...actions} />)}
    </div>
  );
}

function Chat({ roomId, member, markRoomRead, ...actions }) {
  const load = useCallback(() => member ? getMessages(roomId) : Promise.resolve([]), [member, roomId]);
  const resource = useResource(load);
  const { refresh } = resource;
  const log = useRef(null);
  useRoomReadMarker(roomId, 'chat', resource.error ? null : resource.items?.at(-1)?.id, markRoomRead);

  useEffect(() => {
    if (!supabase || !member) return;
    const channel = supabase.channel(`room:${roomId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, refresh)
      .subscribe(status => { if (status === 'SUBSCRIBED') refresh(); });
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      window.clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, [member, roomId, refresh]);

  const latestId = resource.items?.at(-1)?.id;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [latestId]);

  if (!member) return <div className="signin-state"><h3>Come in and say hello</h3><p>This chat is for registered students. Sign in to read messages and join in.</p><button className="primary" onClick={actions.requireProfile}>Sign in or create an account <ArrowRight size={15} /></button></div>;

  return (
    <div className="chat">
      <div className="chat-log" ref={log} role="log" aria-label="Room messages" tabIndex={0}>
        <Status resource={resource} />
        {resource.items?.length === 0 && <p className="state">No messages yet. Say hello.</p>}
        {resource.items?.map(entry => (
          <article className="short-entry" key={entry.id}>
            <div className="entry-head"><Author entry={entry} /><EntryControls entry={entry} table="messages" onDelete={refresh} {...actions} /></div>
            <p>{entry.body}</p>
          </article>
        ))}
      </div>
      <EntryForm table="messages" fields={{ room_id: roomId }} label="Write a message" onSent={refresh} {...actions} />
    </div>
  );
}

function ReportForm({ report, onSent }) {
  const [reason, setReason] = useState('');
  const { run, pending, error } = useAction();

  return (
    <form className="dialog-form" onSubmit={event => {
      event.preventDefault();
      if (reason.trim()) run(async () => {
        await reportEntry(report.kind, report.id, reason.trim());
        onSent();
      });
    }}>
      <label>What happened?<textarea required maxLength={500} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={pending || !reason.trim()}>Send report</button>
    </form>
  );
}

function App() {
  const [sessionUser, setSessionUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileRetry, setProfileRetry] = useState(0);
  const [roomId, setRoomId] = useState(() => currentRoute(window.location).roomId);
  const [view, setView] = useState(() => currentRoute(window.location).view);
  const [conversationId, setConversationId] = useState(() => currentRoute(window.location).conversationId || null);
  const [postId, setPostId] = useState(() => currentRoute(window.location).postId || null);
  const [recovery, setRecovery] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authNotice, setAuthNotice] = useState('');
  const [query, setQuery] = useState('');
  const [mobile, setMobile] = useState(false);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [admin, setAdmin] = useState(null);
  const [roleError, setRoleError] = useState(false);
  const [roleRetry, setRoleRetry] = useState(0);
  const userId = sessionUser?.id;
  const member = Boolean(userId);
  const room = roomById[roomId];
  const specialView = ['ambassadors', 'admin', 'messages', 'members'].includes(view);
  const canMessage = Boolean(userId && sessionUser?.email_confirmed_at && profile);
  const inbox = useMessaging(canMessage ? userId : null);
  const notifications = useNotifications(canMessage ? userId : null);
  const roomUnread = (id, tab) => notifications.rooms.filter(item => item.room_id === id && (!tab || item.view === tab)).reduce((sum, item) => sum + Number(item.unread_count), 0);

  useEffect(() => {
    let active = true;
    setAdmin(null); setRoleError(false);
    const refresh = () => { if (userId) getAdminStatus().then(value => { if (active) { setAdmin(value); setRoleError(false); } }).catch(() => { if (active) { setAdmin(null); setRoleError(true); } }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, [userId, roleRetry]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const callbackUrl = new URL(location.href);
    initialAuthSession(supabase.auth).then(({ data, error }) => {
      if (!active) return;
      const failure = authCallbackFailure(callbackUrl, error, data.session);
      if (failure) {
        setAuthNotice(failure.message);
        setRecovery(false);
        setAuthMode(failure.mode);
        setModal('auth');
        history.replaceState(null, '', cleanAuthCallbackUrl(callbackUrl));
      } else if (data.session && callbackUrl.searchParams.get('auth') === 'google') {
        history.replaceState(null, '', cleanAuthCallbackUrl(callbackUrl));
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSessionUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY' || (session && new URLSearchParams(location.search).get('reset') === '1' && !authCallbackFailure(callbackUrl, null, session))) { setRecovery(true); setModal('auth'); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let active = true;
    setProfile(null);
    setProfileError(false);
    setProfileLoading(Boolean(userId));
    if (userId) {
      getProfile(userId).then(next => { if (active) { setProfile(next); if (!next) setModal('auth'); } })
        .catch(() => { if (active) setProfileError(true); })
        .finally(() => { if (active) setProfileLoading(false); });
    }
    return () => { active = false; };
  }, [userId, profileRetry]);

  function navigate(nextRoom, nextView = 'posts', nextConversation = null, nextPost = null) {
    const destination = new URL(roomUrl(nextRoom, nextView, window.location, import.meta.env.VITE_ROOM_SUBDOMAINS === 'true', nextConversation, nextPost));
    if (destination.origin !== window.location.origin) { window.location.assign(destination.href); return; }
    window.history.pushState(null, '', destination.href);
    setRoomId(nextRoom);
    setView(nextView);
    setConversationId(nextConversation);
    setPostId(nextPost);
    setQuery('');
    setMobile(false);
  }

  useEffect(() => {
    const update = () => { const route = currentRoute(window.location); setRoomId(route.roomId); setView(route.view); setConversationId(route.conversationId || null); setPostId(route.postId || null); };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  function requireProfile() {
    if (profileError) {
      setProfileRetry(value => value + 1);
      return;
    }
    if (!profileLoading) setModal('auth');
  }

  async function signOut() {
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    }
    setModal(null);
    setNotice('');
  }

  const actions = { profile, userId, requireProfile, onReport: setModal };

  return (
    <div className="app">
      <a className="skip-link" href="#conversations">Skip to conversations</a>
      {mobile && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? 'sidebar-open' : ''}`} aria-label="Community navigation">
        <button className="brand" onClick={() => navigate(null)}><span className="brand-icon"><MessageCircle size={21} /></span>interoom</button>
        <p className="sidebar-caption">A community for international students.</p>
        <nav>
          <button className={!room && !specialView ? 'current' : ''} aria-current={!room && !specialView ? 'page' : undefined} onClick={() => navigate(null)}><Compass size={18} /> All conversations</button>
          <button className={view === 'messages' ? 'current' : ''} aria-current={view === 'messages' ? 'page' : undefined} onClick={() => navigate(null, 'messages')}><MessageCircle size={18} /> Messages <UnreadBadge count={inbox.unread_count} /></button>
          <button className={view === 'members' ? 'current' : ''} aria-current={view === 'members' ? 'page' : undefined} onClick={() => navigate(null, 'members')}><Users size={18} /> Members</button>
          <button className={view === 'ambassadors' ? 'current' : ''} aria-current={view === 'ambassadors' ? 'page' : undefined} onClick={() => navigate(null, 'ambassadors')}><GraduationCap size={18} /> Ambassadors</button>
          {admin && <button className={view === 'admin' ? 'current' : ''} aria-current={view === 'admin' ? 'page' : undefined} onClick={() => navigate(null, 'admin')}><ShieldCheck size={18} /> Admin panel</button>}
          <p className="nav-label">Rooms</p>
          {rooms.map(item => (
            <button key={item.id} className={roomId === item.id ? 'current' : ''} aria-current={roomId === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
              <Hash size={17} />{item.name}<UnreadBadge count={roomUnread(item.id)} label="unread room updates" />
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom"><button className="sidebar-chat" onClick={() => navigate('general', 'chat')}><MessageCircle size={18} /> General chat <ArrowUpRight size={15} /></button><p className="sidebar-note">Different schools. A shared room.</p></div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={mobile} onClick={() => setMobile(!mobile)}><Menu size={23} /></button>
          <span className="topbar-label">The student community</span>
          {!specialView && <label className="search">
            <Search size={17} />
            <input type="search" aria-label="Search recent posts" placeholder="Search recent posts" value={query} onChange={event => {
              setQuery(event.target.value);
              if (view === 'chat') { const url = roomUrl(roomId, 'posts', window.location, false); history.replaceState(null, '', url); setView('posts'); }
            }} />
          </label>}
          {admin && <span className="admin-label">Admin</span>}
          {member && <button className="icon-button" aria-label={`Messages${inbox.unread_count ? `, ${inbox.unread_count} unread` : ''}`} onClick={() => navigate(null, 'messages')}><MessageCircle size={20} /><UnreadBadge count={inbox.unread_count} /></button>}
          {canMessage && <NotificationBell key={userId} notifications={notifications} onOpen={item => item.kind.startsWith('friend_') ? navigate(null, 'members') : item.kind === 'dm' ? navigate(null, 'messages', item.conversation_id) : navigate(item.room_id, 'posts', null, item.post_id)} />}
          <button className="account" onClick={requireProfile}>{profile && <Avatar name={profile.name} />}{profile?.name || (userId ? 'Set up profile' : 'Sign in')}</button>
        </header>

        <main className="content">
          {specialView ? <>
            {view === 'members' ? <MembersPage key={userId || 'guest'} userId={userId} eligible={canMessage} signIn={requireProfile} openConversation={id => navigate(null, 'messages', id)} /> : view === 'messages' ? <MessagesPage key={userId || 'guest'} userId={userId} eligible={canMessage} inbox={inbox} conversationId={conversationId} openConversation={id => navigate(null, 'messages', id)} signIn={requireProfile} /> : view === 'ambassadors' ? <AmbassadorDirectory member={member} signIn={requireProfile} /> : <AmbassadorAdmin member={member} admin={admin} roleError={roleError} refreshRole={() => setRoleRetry(v => v + 1)} signIn={requireProfile} onChanged={() => setProfileRetry(v => v + 1)} />}
          </> : <>
          {!room ? <section className="welcome">
            <div className="welcome-copy"><span className="welcome-eyebrow">Different schools. A shared room.</span><h1>Welcome to<br /><em>Interoom.</em></h1><p>A place to talk about school, moving abroad, and the things your friends back home might not get.</p><div className="welcome-note"><span>New here? Start with a hello.</span><button className="text-button" onClick={() => navigate('general', 'chat')}>Go to General <ArrowRight size={14} /></button></div></div>
            <OrbitalGlobe />
          </section> : <div className="page-intro">
            <button className="text-button back" onClick={() => navigate(null)}><ArrowLeft size={15} /> All conversations</button>
            <h1>{room.name}</h1><p>{room.description}</p>
          </div>}

          {!supabase && <p className="demo-note">Interoom is being connected. Accounts and conversations will be available shortly.</p>}
          {profileError && <p className="state" role="alert">Couldn’t load your profile. <button className="text-button" onClick={requireProfile}>Try again</button></p>}
          {notice && <p className="demo-note" role="status">{notice}</p>}

          <div className="below">
            <section id="conversations" className="main-column" aria-label={view === 'chat' ? 'Room chat' : 'Discussion feed'}>
              <div className="feed-toolbar">
                {room ? (
                  <div className="view-switch">
                    <button aria-pressed={view === 'posts'} onClick={() => navigate(roomId, 'posts')}>Posts<UnreadBadge count={roomUnread(roomId, 'posts')} label="unread posts" /></button>
                    <button aria-pressed={view === 'chat'} onClick={() => navigate(roomId, 'chat')}>Room chat<UnreadBadge count={roomUnread(roomId, 'chat')} label="unread room messages" /></button>
                  </div>
                ) : <h2>Recent conversations</h2>}
                {view === 'posts' && <button className="primary" onClick={() => profile ? setModal('compose') : requireProfile()}><Plus size={17} /> New post</button>}
              </div>
              {view === 'chat' ? (
                <Chat key={roomId} roomId={roomId} member={member} markRoomRead={notifications.readRoom} {...actions} />
              ) : (
                <Feed key={`${userId}:${roomId}:${revision}:${postId}`} roomId={roomId} query={query} postId={postId} member={member} onRoom={navigate} markRoomRead={notifications.readRoom} {...actions} />
              )}
            </section>

            <aside className="room-guide" aria-label="Room directory">
              <h2>Find your room</h2>
              {rooms.map((item, index) => (
                <button key={item.id} onClick={() => navigate(item.id)}>
                  <span className="room-number" aria-hidden="true">0{index + 1}</span>
                  <span><strong>{item.name}</strong><small>{item.description}</small></span>
                  <ArrowRight size={16} className="room-arrow" />
                </button>
              ))}
              <p className="room-etiquette"><strong>A quick reminder</strong>Be kind, leave personal details out of public conversations, and use the flag to report a problem.</p>
            </aside>
          </div>
          </>}
        </main>
      </div>

      {modal === 'auth' && <Modal title={recovery ? 'Choose a new password' : profile ? 'Your profile' : supabase && !userId ? 'Sign in to Interoom' : 'Choose a display name'} close={() => { setModal(null); setAuthNotice(''); }}>
        <AuthForm key={`${userId}:${Boolean(profile)}:${recovery}:${authMode}`} initialMode={authMode} initialNotice={authNotice} recovery={recovery} metadata={sessionUser?.user_metadata} userId={userId} profile={profile} onSaved={next => { setAuthNotice(''); setProfile(next); if (recovery) setNotice('Password updated. You’re signed in.'); setRecovery(false); setAuthMode('login'); const url = new URL(location.href); url.searchParams.delete('reset'); url.searchParams.delete('code'); history.replaceState(null, '', url.pathname + url.search); setModal(null); }} onSignOut={signOut} />
      </Modal>}
      {modal === 'compose' && <Modal title="New post" close={() => setModal(null)}>
        <Compose selectedRoom={roomId} profile={profile} close={() => setModal(null)} onPosted={nextRoom => {
          navigate(roomId ? nextRoom : null);
          setRevision(value => value + 1);
        }} />
      </Modal>}
      {modal?.kind && <Modal title={`Report ${modal.kind}`} close={() => setModal(null)}>
        <ReportForm report={modal} onSent={() => { setModal(null); setNotice('Report sent.'); }} />
      </Modal>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);

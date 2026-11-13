import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, Compass, Flag, Hash, Heart, LogOut,
  Menu, MessageCircle, Plus, Search, Send, Trash2, X,
} from 'lucide-react';
import {
  addEntry, deleteEntry, getMessages, getPosts, getProfile, getReplies,
  reportEntry, saveProfile, setReaction, supabase,
} from './community';
import { roomById, rooms } from './rooms';
import { currentRoute, roomUrl } from './routing';
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
    } catch {
      setError(message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return { pending, error, run };
}

function Avatar({ name }) {
  const letters = (name || 'Member').split(/\s+/).slice(0, 2).map(word => word[0]).join('');
  return <span className="avatar" aria-hidden="true">{letters}</span>;
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

function AuthForm({ userId, profile, metadata, recovery, onSaved, onSignOut }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(profile?.name ?? metadata?.name ?? '');
  const [country, setCountry] = useState(profile?.country ?? metadata?.country ?? '');
  const [sent, setSent] = useState('');
  const { run, pending, error } = useAction();
  if (!supabase) return <p>Account setup is temporarily unavailable.</p>;
  function submit(event) {
    event.preventDefault();
    run(async () => {
      if (recovery) {
        const result = await supabase.auth.updateUser({ password });
        if (result.error) throw result.error;
        onSaved(profile);
      } else if (userId) {
        const next = { name: name.trim(), country: country.trim() };
        await saveProfile(userId, next, Boolean(profile));
        onSaved(next);
      } else if (mode === 'reset') {
        const result = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin + '/?reset=1',
        });
        if (result.error) throw result.error;
        setSent('If an account exists for that email, you’ll receive a password reset link.');
      } else if (mode === 'signup') {
        const result = await supabase.auth.signUp({ email: email.trim(), password,
          options: { emailRedirectTo: window.location.origin + '/', data: { name: name.trim(), country: country.trim() } },
        });
        if (result.error) throw result.error;
        setSent(result.data.session ? 'Account created. Finish setting up your profile.' : 'Check your inbox to confirm your email. Then sign in here.');
      } else {
        const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw result.error;
      }
    }, mode === 'login' && !userId ? 'Couldn’t sign in. Check your email and password and confirm your email first.' : 'Couldn’t complete that request. Please try again shortly.');
  }
  return <form className="dialog-form" onSubmit={submit}>
    {!userId && <div className="view-switch">{[['login', 'Sign in'], ['signup', 'Create account']].map(([value, label]) =>
      <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setMode(value); setSent(''); }}>{label}</button>)}</div>}
    {sent && <p role="status">{sent}</p>}
    {!userId && <label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>}
    {(recovery || (!userId && mode !== 'reset')) && <label>{recovery ? 'New password' : 'Password'}<input type="password" required minLength={mode === 'login' && !recovery ? 1 : 8} autoComplete={mode === 'login' && !recovery ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>}
    {!recovery && (userId || mode === 'signup') && <>
      <label>Display name<input required minLength={2} maxLength={40} autoComplete="nickname" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Country (optional)<input maxLength={60} value={country} onChange={e => setCountry(e.target.value)} /></label>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary" disabled={pending}>{pending ? 'Please wait…' : recovery ? 'Save new password' : userId ? 'Save profile' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
    {userId ? <button type="button" className="text-button" disabled={pending} onClick={() => run(onSignOut)}>Sign out</button> :
      <button type="button" className="text-button" onClick={() => { setMode('reset'); setSent(''); }}>Forgot password?</button>}
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

function Post({ post, refresh, onRoom, ...actions }) {
  const [expanded, setExpanded] = useState(false);
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

function Feed({ roomId, query, member, onRoom, ...actions }) {
  const load = useCallback(() => member ? getPosts(roomId, actions.userId) : Promise.resolve([]), [member, roomId, actions.userId]);
  const resource = useResource(load);
  const term = query.trim().toLowerCase();
  const posts = resource.items?.filter(post => [post.body, post.profile?.name, roomById[post.room_id]?.name]
    .some(value => value?.toLowerCase().includes(term)));

  if (!member) return <p className="state">Sign in to read and join the conversations. <button className="text-button" onClick={actions.requireProfile}>Sign in</button></p>;

  return (
    <div className="feed">
      <Status resource={resource} />
      {posts?.length === 0 && <p className="state">{term ? 'No matching posts.' : 'No posts in this room yet.'}</p>}
      {posts?.map(post => <Post key={post.id} post={post} refresh={resource.refresh} onRoom={onRoom} {...actions} />)}
    </div>
  );
}

function Chat({ roomId, member, ...actions }) {
  const load = useCallback(() => member ? getMessages(roomId) : Promise.resolve([]), [member, roomId]);
  const resource = useResource(load);
  const { refresh } = resource;
  const log = useRef(null);

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

  if (!member) return <p className="state">Sign in to read and send messages. <button className="text-button" onClick={actions.requireProfile}>Sign in</button></p>;

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
  const [recovery, setRecovery] = useState(false);
  const [query, setQuery] = useState('');
  const [mobile, setMobile] = useState(false);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const userId = sessionUser?.id;
  const member = Boolean(userId);
  const room = roomById[roomId];

  useEffect(() => {
    if (!supabase) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSessionUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY' || (session && new URLSearchParams(location.search).get('reset') === '1')) { setRecovery(true); setModal('auth'); }
    });
    return () => subscription.unsubscribe();
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

  function navigate(nextRoom, nextView = 'posts') {
    const destination = new URL(roomUrl(nextRoom, nextView, window.location, import.meta.env.VITE_ROOM_SUBDOMAINS === 'true'));
    if (destination.origin !== window.location.origin) { window.location.assign(destination.href); return; }
    window.history.pushState(null, '', destination.href);
    setRoomId(nextRoom);
    setView(nextView);
    setQuery('');
    setMobile(false);
  }

  useEffect(() => {
    const update = () => { const route = currentRoute(window.location); setRoomId(route.roomId); setView(route.view); };
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
      {mobile && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? 'sidebar-open' : ''}`} aria-label="Community navigation">
        <button className="brand" onClick={() => navigate(null)}><span className="brand-icon"><MessageCircle size={21} /></span>interoom</button>
        <nav>
          <button className={!room ? 'current' : ''} aria-current={!room ? 'page' : undefined} onClick={() => navigate(null)}><Compass size={18} /> All conversations</button>
          <p className="nav-label">Rooms</p>
          {rooms.map(item => (
            <button key={item.id} className={roomId === item.id ? 'current' : ''} aria-current={roomId === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
              <Hash size={17} />{item.name}
            </button>
          ))}
        </nav>
        <button className="sidebar-chat" onClick={() => navigate('general', 'chat')}><MessageCircle size={18} /> General chat <ArrowUpRight size={15} /></button>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={mobile} onClick={() => setMobile(!mobile)}><Menu size={23} /></button>
          <label className="search">
            <Search size={17} />
            <input type="search" aria-label="Search recent posts" placeholder="Search recent posts" value={query} onChange={event => {
              setQuery(event.target.value);
              if (view === 'chat') { const url = roomUrl(roomId, 'posts', window.location, false); history.replaceState(null, '', url); setView('posts'); }
            }} />
          </label>
          <button className="account" onClick={requireProfile}>{profile && <Avatar name={profile.name} />}{profile?.name || (userId ? 'Set up profile' : 'Sign in')}</button>
        </header>

        <main className="content">
          {!room && <section className="hero"><div className="hero-copy"><span className="eyebrow">INTEROOM</span><h1>Different places.<br /><em>Same wavelength.</em></h1><p>Meet other international students, share your experience, and talk about school and life abroad.</p><button className="primary" onClick={() => profile ? setModal('compose') : requireProfile()}>Start a conversation <ArrowUpRight size={18} /></button></div></section>}
          <div className="page-intro">
            {room && <button className="text-button back" onClick={() => navigate(null)}><ArrowLeft size={15} /> All conversations</button>}
            <h1>{room ? room.name : 'Around the room'}</h1>
            <p>{room?.description ?? 'A forum for international students to talk about school, moving countries, and what comes next.'}</p>
          </div>

          {!supabase && <p className="demo-note">Interoom is being connected. Accounts and conversations will be available shortly.</p>}
          {profileError && <p className="state" role="alert">Couldn’t load your profile. <button className="text-button" onClick={requireProfile}>Try again</button></p>}
          {notice && <p className="demo-note" role="status">{notice}</p>}

          <div className="below">
            <section className="main-column" aria-label={view === 'chat' ? 'Room chat' : 'Discussion feed'}>
              <div className="feed-toolbar">
                {room ? (
                  <div className="view-switch">
                    <button aria-pressed={view === 'posts'} onClick={() => navigate(roomId, 'posts')}>Posts</button>
                    <button aria-pressed={view === 'chat'} onClick={() => navigate(roomId, 'chat')}>Room chat</button>
                  </div>
                ) : <h2>Latest posts</h2>}
                {view === 'posts' && <button className="primary" onClick={() => profile ? setModal('compose') : requireProfile()}><Plus size={17} /> New post</button>}
              </div>
              {view === 'chat' ? (
                <Chat key={roomId} roomId={roomId} member={member} {...actions} />
              ) : (
                <Feed key={`${userId}:${roomId}:${revision}`} roomId={roomId} query={query} member={member} onRoom={navigate} {...actions} />
              )}
            </section>

            <aside className="room-guide right-card" aria-label="Room directory">
              <h2>Pick a room</h2>
              {rooms.map(item => (
                <button key={item.id} onClick={() => navigate(item.id)}>
                  <span className="room-symbol"><Hash size={17} /></span>
                  <span><strong>{item.name}</strong><small>{item.description}</small></span>
                  <ArrowRight size={16} className="room-arrow" />
                </button>
              ))}
            </aside>
          </div>
        </main>
      </div>

      {modal === 'auth' && <Modal title={recovery ? 'Reset password' : profile ? 'Your profile' : supabase && !userId ? 'Sign in to Interoom' : 'Choose a display name'} close={() => setModal(null)}>
        <AuthForm key={`${userId}:${Boolean(profile)}:${recovery}`} recovery={recovery} metadata={sessionUser?.user_metadata} userId={userId} profile={profile} onSaved={next => { setProfile(next); setRecovery(false); const url = new URL(location.href); url.searchParams.delete('reset'); url.searchParams.delete('code'); history.replaceState(null, '', url.pathname + url.search); setModal(null); }} onSignOut={signOut} />
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

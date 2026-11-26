import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Globe2, MessageCircle, Search, UserPlus, Users, X } from 'lucide-react';
import { supabase } from './community';
import { messagingApi } from './messaging';
import { createMembersApi, memberError } from './members-api';
import './members.css';

export const membersApi = createMembersApi(supabase);
const tabs = [['discover', 'Discover'], ['friends', 'Friends'], ['requests', 'Requests']];

function ProfileDetails({ initial, save, cancel, editBasic }) {
  const [values, setValues] = useState(initial), [pending, setPending] = useState(false), [error, setError] = useState('');
  const busy = useRef(false);
  const update = (key, value) => setValues(old => ({ ...old, [key]: value }));
  return <form className="dialog-form member-profile-form" onSubmit={async event => {
    event.preventDefault(); if (busy.current) return; busy.current = true; setPending(true); setError('');
    try { await save(values); } catch (e) { setError(memberError(e)); } finally { busy.current = false; setPending(false); }
  }}>
    <div className="member-section-title"><h2>A little about you</h2><button type="button" className="icon-button" aria-label="Close profile details" disabled={pending} onClick={cancel}><X size={19} /></button></div>
    <p>These details are visible to other members. Leave out contact details and anything you want to keep private.</p>
    <label>Bio<textarea rows={3} maxLength={280} value={values.bio} onChange={e => update('bio', e.target.value)} placeholder="What brought you here?" /></label>
    <label>Interests<input maxLength={160} value={values.interests} onChange={e => update('interests', e.target.value)} placeholder="Robotics, football, films…" /><small>Separate interests with commas.</small></label>
    <label>Languages<input maxLength={120} value={values.languages} onChange={e => update('languages', e.target.value)} placeholder="Turkish, English…" /></label>
    <label className="member-setting"><input type="checkbox" checked={values.discoverable} onChange={e => update('discoverable', e.target.checked)} /><span>Show me in member discovery<small>Turning this off keeps your profile available to existing friends and pending requests.</small></span></label>
    <label className="member-setting"><input type="checkbox" checked={values.allow_requests} onChange={e => update('allow_requests', e.target.checked)} /><span>Allow new friend requests</span></label>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary" disabled={pending}>{pending ? 'Saving…' : 'Save details'}</button><button type="button" className="text-button" disabled={pending} onClick={editBasic}>Edit name and school</button></div>
  </form>;
}

export function MembersPage({ userId, eligible, signIn, openConversation, editBasic = signIn, api = membersApi, messageApi = messagingApi }) {
  const [section, setSection] = useState('discover'), [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const [data, setData] = useState(null), [editing, setEditing] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const request = useRef(0), busy = useRef(false);
  const key = JSON.stringify([userId, section, query, page]);
  const refresh = useCallback(async () => {
    if (!eligible) return;
    const version = ++request.current;
    try {
      const result = await api.list(query, section, page);
      if (version !== request.current) return;
      if (page > 0 && !result.items.length) { setPage(Math.max(0, Math.ceil(result.total / 24) - 1)); return; }
      setData({ ...result, key });
    }
    catch (e) { if (version === request.current) setData({ key, loadError: memberError(e) }); }
  }, [api, eligible, query, section, page, key]);
  useEffect(() => {
    if (!eligible) return;
    let debounce;
    const changed = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 150); };
    const recover = () => { if (!document.hidden) refresh(); };
    const stop = api.watch(userId, changed); refresh();
    const timer = setInterval(recover, 30_000); window.addEventListener('focus', recover); document.addEventListener('visibilitychange', recover);
    return () => { request.current++; stop(); clearInterval(timer); clearTimeout(debounce); window.removeEventListener('focus', recover); document.removeEventListener('visibilitychange', recover); };
  }, [api, userId, eligible, refresh]);
  const visible = data?.key === key ? data : null;
  function changeSection(next) { setSection(next); setPage(0); setQuery(''); setDraft(''); setError(''); }
  async function act(action) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    try { await action(); await refresh(); } catch (e) { setError(memberError(e)); }
    finally { busy.current = false; setPending(false); }
  }
  const header = <div className="member-page-heading"><div className="page-intro"><span className="welcome-eyebrow">Different places. Familiar faces.</span><h1>Find your people.</h1><p>Meet fellow students, find shared interests, and keep in touch.</p></div>{eligible && <button className="account" disabled={!visible?.own} onClick={() => setEditing(!editing)}>My profile</button>}</div>;
  if (!userId || !eligible) return <section>{header}<div className="join-state"><Users size={32} /><h2>Make a connection.</h2><p>Sign in with a verified account and complete your profile to meet other members.</p><button className="primary" onClick={signIn}>Sign in or complete profile</button></div></section>;
  return <section className="members-page">{header}
    {editing && visible?.own && <ProfileDetails initial={visible.own} cancel={() => setEditing(false)} editBasic={editBasic} save={async values => { await api.save(values); setEditing(false); await refresh(); }} />}
    <div className="members-toolbar"><div className="view-switch">{tabs.map(([value, label]) => <button key={value} aria-pressed={section === value} onClick={() => changeSection(value)}>{label}{value === 'requests' && visible?.incoming_count > 0 && <span className="unread-badge" aria-label={`${visible.incoming_count} incoming friend requests`}>{visible.incoming_count}</span>}{value === 'friends' && visible?.friends_count > 0 && <span className="member-count">{visible.friends_count}</span>}</button>)}</div>
      <form className="member-search-form" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); setPage(0); }}><label className="sr-only" htmlFor={`member-search-${userId}`}>Search members</label><input id={`member-search-${userId}`} type="search" value={draft} maxLength={80} onChange={e => setDraft(e.target.value)} placeholder="Name, school, country or interest" /><button className="icon-button" aria-label="Search members"><Search size={19} /></button></form>
    </div>
    {visible?.incoming_count > 0 && section !== 'requests' && <button className="member-request-banner" onClick={() => changeSection('requests')}><UserPlus size={18} /><span>You have {visible.incoming_count} friend {visible.incoming_count === 1 ? 'request' : 'requests'}.</span><span>View requests →</span></button>}
    {!visible && <p className="state" role="status">Finding members…</p>}
    {visible?.loadError && <p className="state" role="alert">{visible.loadError} <button className="text-button" onClick={refresh}>Try again</button></p>}
    {error && <p className="error" role="alert">{error}</p>}
    {visible?.items?.length === 0 && <div className="member-empty"><Users size={30} /><h2>{query ? 'No matches yet.' : section === 'friends' ? 'Every friendship starts with hello.' : section === 'requests' ? 'No pending requests.' : 'More people will arrive soon.'}</h2><p>{query ? 'Try another name, school, country or interest.' : section === 'friends' ? 'Explore the community and send your first friend request.' : section === 'requests' ? 'Requests you send and receive will appear here.' : 'Come back soon to meet other members.'}</p>{section !== 'discover' && <button className="text-button" onClick={() => changeSection('discover')}>Discover members</button>}</div>}
    <div className="member-grid">{visible?.items?.map(person => <article className="member-card" key={person.id}>
      <header><span className="dm-avatar" aria-hidden="true">{person.name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('')}</span><div><h2>{person.name}</h2>{person.username && <small>@{person.username}</small>}</div>{person.relationship === 'friends' && <span className="member-friend-label"><Check size={14} /> Friends</span>}</header>
      {(person.school || person.country) && <p className="member-location"><Globe2 size={14} aria-hidden="true" />{[person.school, person.country].filter(Boolean).join(' · ')}</p>}
      {person.bio && <p className="member-bio">{person.bio}</p>}
      {person.interests && <ul className="member-tags" aria-label="Interests">{person.interests.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8).map((s, i) => <li key={i}>{s}</li>)}</ul>}
      {person.languages && <p className="member-languages">Speaks {person.languages}</p>}
      <div className="member-card-actions">
        {person.relationship === 'none' && person.allow_requests && <button className="primary" disabled={pending} onClick={() => act(() => api.act(person.id, 'request'))}><UserPlus size={15} /> Add friend</button>}
        {person.relationship === 'incoming' && <><button className="primary" disabled={pending} onClick={() => act(() => api.act(person.id, 'accept'))}><Check size={15} /> Accept request</button><button className="text-button" disabled={pending} onClick={() => act(() => api.act(person.id, 'decline'))}>Decline</button></>}
        {person.relationship === 'outgoing' && <><span className="member-pending">Request sent</span><button className="text-button" disabled={pending} onClick={() => act(() => api.act(person.id, 'cancel'))}>Cancel request</button></>}
        {person.can_message && <button className="account" disabled={pending} onClick={() => act(async () => openConversation(await messageApi.start(person.id)))}><MessageCircle size={15} /> Message</button>}
        {person.relationship === 'friends' && <button className="text-button member-remove" disabled={pending} onClick={() => act(() => api.act(person.id, 'remove'))}>Remove friend</button>}
      </div>
    </article>)}</div>
    {visible?.total > 24 && <div className="member-pagination"><button className="account" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(visible.total / 24))}</span><button className="account" disabled={(page + 1) * 24 >= visible.total} onClick={() => setPage(p => p + 1)}>Next</button></div>}
  </section>;
}

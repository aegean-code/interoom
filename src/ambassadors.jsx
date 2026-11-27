import React, { useEffect, useState } from 'react';
import { GraduationCap, Search, ShieldCheck } from 'lucide-react';
import { Avatar } from './avatar';
import { getAdminMembers, getAmbassadors, setAmbassador } from './community';

export function AmbassadorBadge({ appointment }) {
  const school = Array.isArray(appointment) ? appointment[0]?.school : appointment?.school;
  return school ? <span className="ambassador-badge"><GraduationCap size={13} aria-hidden="true" />Ambassador · {school}</span> : null;
}

export function AmbassadorDirectory({ member, signIn }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState({ loading: true });
  useEffect(() => {
    let active = true;
    setResult({ loading: true });
    if (member) getAmbassadors(search, page).then(items => { if (active) setResult({ items }); })
      .catch(() => { if (active) setResult({ error: true }); });
    return () => { active = false; };
  }, [member, search, page, retry]);
  return <section id="conversations" aria-label="School ambassadors">
    <div className="page-intro"><span className="welcome-eyebrow">People to say hello to</span><h1>School ambassadors</h1><p>Meet students who represent their international schools on Interoom.</p></div>
    {!member ? <div className="signin-state"><h3>Find a familiar school.</h3><p>Sign in to meet the ambassadors. School badges are assigned by an Interoom admin.</p><button className="primary" onClick={signIn}>Sign in to view ambassadors</button></div> : <>
      <form className="member-search" onSubmit={e => { e.preventDefault(); setSearch(draft); setPage(0); }}><label>Find a school<input type="search" placeholder="School name" maxLength={120} value={draft} onChange={e => setDraft(e.target.value)} /></label><button className="primary"><Search size={15} />Search</button></form>
      {result.loading && <p className="state" role="status">Loading ambassadors…</p>}
      {result.error && <p className="state" role="alert">Couldn’t load ambassadors. <button className="text-button" onClick={() => setRetry(v => v + 1)}>Try again</button></p>}
      {result.items?.length === 0 && <div className="signin-state"><h3>{search ? 'No schools matched.' : 'The first ambassadors are on their way.'}</h3><p>{search ? 'Try a different school name.' : 'Once an admin appoints an ambassador, you’ll find their school and display name here.'}</p></div>}
      <div className="ambassador-list">{result.items?.map(person => <article className="ambassador-card" key={person.user_id}><Avatar name={person.profile?.name} userId={person.user_id} path={person.profile?.avatar_path} className="dm-avatar" /><div><h2>{person.school}</h2><strong>{person.profile?.name || 'Member'}</strong>{person.profile?.country && <p>{person.profile.country}</p>}<span className="ambassador-badge">School ambassador</span></div></article>)}</div>
      <div className="pagination">{page > 0 && <button className="text-button" disabled={result.loading} onClick={() => setPage(v => v - 1)}>Previous</button>}{(page > 0 || result.items?.length === 40) && <span>Page {page + 1}</span>}{result.items?.length === 40 && <button className="text-button" onClick={() => setPage(v => v + 1)}>Next</button>}</div>
    </>}
    <p className="ambassador-note">An Interoom ambassador is a student representative within this community, not an official endorsement by their school.</p>
  </section>;
}

function MemberAppointment({ person, onChanged }) {
  const [school, setSchool] = useState(person.ambassador_school || person.school || '');
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { setSchool(person.ambassador_school || person.school || ''); }, [person.ambassador_school, person.school]);
  async function save(value) {
    if (pending) return;
    setPending(true); setError(''); setMessage('');
    try {
      await setAmbassador(person.user_id, value);
      setRemoving(false);
      setMessage(value === null ? 'Ambassador role removed.' : 'School ambassador saved.');
      await onChanged();
    } catch { setError('Couldn’t save this role. Check your admin access and try again.'); }
    finally { setPending(false); }
  }
  return <article className="member-appointment">
    <div className="member-identity"><strong>{person.name}</strong><span>{person.email}</span><small>{person.school || 'No school on profile'}</small><AmbassadorBadge appointment={person.ambassador_school ? { school: person.ambassador_school } : null} /></div>
    <form className="appointment-form" onSubmit={e => { e.preventDefault(); save(school.trim()); }}>
      <label>School to represent<input required minLength={2} maxLength={120} value={school} onChange={e => setSchool(e.target.value)} disabled={pending} /></label>
      <div className="dialog-actions"><button className="primary" disabled={pending || school.trim().length < 2}>{pending ? 'Saving…' : person.ambassador_school ? 'Update school' : 'Assign ambassador'}</button>
      {person.ambassador_school && <button className="text-button danger" type="button" disabled={pending} onClick={() => setRemoving(true)}>Remove role</button>}</div>
    </form>
    {removing && <div className="role-confirm"><p>Remove {person.name} as ambassador for {person.ambassador_school}?</p><button className="text-button danger" disabled={pending} onClick={() => save(null)}>Confirm removal</button><button className="text-button" disabled={pending} onClick={() => setRemoving(false)}>Cancel</button></div>}
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="role-status" role="status">{message}</p>}
  </article>;
}

export function AmbassadorAdmin({ member, admin, roleError, refreshRole, signIn, onChanged, loadMembers = getAdminMembers }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState({ loading: true });
  const [roleNotice, setRoleNotice] = useState('');
  useEffect(() => {
    let active = true;
    setResult({ loading: true });
    if (!member || !admin) return;
    loadMembers(search, page).then(next => { if (active) setResult(next); }).catch(() => { if (active) setResult({ error: true }); });
    return () => { active = false; };
  }, [member, admin, search, page, revision, loadMembers]);
  function changed() {
    setRoleNotice('Ambassador changes saved.');
    setRevision(value => value + 1);
    onChanged();
  }
  function changePage(next) { setSelectedId(null); setPage(next); }
  return <section id="conversations" aria-label="Admin panel">
    <div className="page-intro"><span className="welcome-eyebrow"><ShieldCheck size={13} /> Interoom administration</span><h1>Registered users</h1><p>View every registered account and manage school ambassadors.</p></div>
    {!member ? <div className="signin-state"><h3>Admin sign-in required</h3><p>Sign in with your administrator account to view users and manage school ambassadors.</p><button className="primary" onClick={signIn}>Sign in</button></div>
    : roleError ? <p className="state" role="alert">Couldn’t check your access. <button className="text-button" onClick={refreshRole}>Try again</button></p>
    : admin === null ? <p className="state" role="status">Checking admin access…</p>
    : !admin ? <div className="signin-state"><h3>This page is for admins.</h3><p>Your account doesn’t have permission to view registered users or manage ambassador roles.</p></div>
    : <><form className="member-search" onSubmit={e => { e.preventDefault(); setSearch(draft.trim()); setPage(0); setSelectedId(null); setRoleNotice(''); setRevision(v => v + 1); }}><label>Find a user<input type="search" maxLength={120} placeholder="Name, email, or school" value={draft} onChange={e => setDraft(e.target.value)} /></label><button className="primary"><Search size={15} />Search users</button>
      {search && <button type="button" className="text-button" onClick={() => { setDraft(''); setSearch(''); changePage(0); }}>Show all users</button>}
      <button type="button" className="text-button" disabled={result.loading} onClick={() => setRevision(v => v + 1)}>Refresh</button></form>
      {roleNotice && <p className="role-status" role="status">{roleNotice}</p>}
      {result.loading && <p className="state" role="status">Loading registered users…</p>}
      {result.error && <p className="error" role="alert">Couldn’t load registered users. Check your admin access and try again. <button className="text-button" onClick={() => setRevision(v => v + 1)}>Try again</button></p>}
      {result.items && <>
        <p className="member-count" role="status">{result.total} {search ? 'matching' : 'registered'} {result.total === 1 ? 'user' : 'users'}{result.total > 0 && <span> · Showing {result.page * result.page_size + 1}–{Math.min((result.page + 1) * result.page_size, result.total)}</span>}</p>
        {result.items.length === 0 ? <p className="state">{search ? 'No users matched. Try another name, email, or school.' : 'No registered users yet.'}</p> : <div className="admin-users-scroll" tabIndex={0} role="region" aria-label="Registered users table">
          <table className="admin-users"><caption className="sr-only">Registered accounts, newest first</caption><thead><tr><th scope="col">User</th><th scope="col">School</th><th scope="col">Account status</th><th scope="col">Registered</th><th scope="col">Ambassador</th></tr></thead><tbody>
            {result.items.map(person => <React.Fragment key={person.user_id}><tr>
              <th scope="row"><strong>{person.name || 'Profile not completed'}</strong><span className="member-email">{person.email || 'No email address'}</span>{person.is_admin && <span className="member-admin">Admin</span>}</th>
              <td>{person.school || 'Not provided'}{person.country && <small>{person.country}</small>}</td>
              <td><span className={`member-status ${person.email_verified ? 'verified' : ''}`}>{person.email_verified ? 'Email verified' : 'Email unverified'}</span>{!person.has_profile && <small>Profile not completed</small>}</td>
              <td>{person.created_at ? <time dateTime={person.created_at}>{new Date(person.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time> : 'Not available'}</td>
              <td>{person.ambassador_school && <span className="member-school">{person.ambassador_school}</span>}{person.has_profile ? <button className="text-button" aria-expanded={selectedId === person.user_id} aria-controls={`member-role-${person.user_id}`} onClick={() => setSelectedId(selectedId === person.user_id ? null : person.user_id)}>{selectedId === person.user_id ? 'Close' : person.ambassador_school ? 'Manage role' : 'Assign role'}</button> : <small>Complete profile first</small>}</td>
            </tr>{selectedId === person.user_id && <tr id={`member-role-${person.user_id}`}><td colSpan={5}><div className="selected-member"><h2>School ambassador</h2><MemberAppointment person={person} onChanged={changed} /></div></td></tr>}</React.Fragment>)}
          </tbody></table>
        </div>}
        {result.total > result.page_size && <nav className="pagination" aria-label="Registered users pages"><button className="text-button" disabled={result.page === 0} onClick={() => changePage(result.page - 1)}>Previous</button><span>Page {result.page + 1} of {Math.ceil(result.total / result.page_size)}</span><button className="text-button" disabled={(result.page + 1) * result.page_size >= result.total} onClick={() => changePage(result.page + 1)}>Next</button></nav>}
      </>}
    </>}
  </section>;
}

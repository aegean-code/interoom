import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { supabase } from './community';
import { createAvatarApi, photoError } from './avatar-api';
import { decodePhoto, drawPhoto, encodePhoto } from './photo-image';
import './avatar.css';

const fallbackApi = createAvatarApi(supabase);
const PhotoContext = createContext({ api: fallbackApi, overrides: {}, changed: () => {} });
export function AvatarProvider({ children, api: suppliedApi }) {
  const api = useMemo(() => suppliedApi || createAvatarApi(supabase), [suppliedApi]);
  const [overrides, setOverrides] = useState({});
  const changed = (id, path) => setOverrides(old => ({ ...old, [id]: path }));
  return <PhotoContext.Provider value={{ api, overrides, changed }}>{children}</PhotoContext.Provider>;
}
function usePhotoPath(userId, path) {
  const context = useContext(PhotoContext);
  return { ...context, path: Object.hasOwn(context.overrides, userId) ? context.overrides[userId] : path || null };
}
export function Avatar({ name, userId, path: initialPath, className = 'avatar' }) {
  const { api, path } = usePhotoPath(userId, initialPath);
  const [image, setImage] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => { if (!document.hidden) api.url(path).then(url => { if (active) setImage({ path, url }); }).catch(() => { if (active) setImage(null); }); };
    load(); const timer = setInterval(load, 240_000); window.addEventListener('focus', load);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', load); };
  }, [api, path]);
  const url = image?.path === path ? image.url : null;
  return <span className={`${className} profile-avatar`} aria-hidden="true">{url ? <img src={url} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => { api.invalidate(path); setImage(null); }} /> : (name || 'Member').trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</span>;
}

export function AvatarEditor({ userId, name, path: initialPath, disabled = false }) {
  const { api, path, changed } = usePhotoPath(userId, initialPath);
  const [bitmap, setBitmap] = useState(null), [zoom, setZoom] = useState(1), [horizontal, setHorizontal] = useState(50), [vertical, setVertical] = useState(50);
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const file = useRef(null), canvas = useRef(null), busy = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => () => { bitmap?.close(); }, [bitmap]);
  useEffect(() => { if (bitmap && canvas.current) drawPhoto(canvas.current, bitmap, zoom, horizontal, vertical); }, [bitmap, zoom, horizontal, vertical]);
  async function choose(selected) {
    if (!selected || busy.current) return;
    const version = ++generation.current;
    busy.current = true; setPending(true); setError(''); setMessage('');
    try { const next = await decodePhoto(selected); if (version !== generation.current) { next.close(); return; } setZoom(1); setHorizontal(50); setVertical(50); setBitmap(next); }
    catch (e) { if (version === generation.current) setError(photoError(e)); }
    finally { if (version === generation.current) { busy.current = false; setPending(false); } }
  }
  async function save(remove = false) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); setMessage('');
    try {
      const blob = remove ? null : await encodePhoto(canvas.current);
      const next = await api.save(userId, blob, path);
      changed(userId, next); setBitmap(null); setMessage(remove ? 'Photo removed.' : 'Photo saved.');
    } catch (e) { setError(photoError(e)); }
    finally { busy.current = false; setPending(false); }
  }
  return <div className="photo-editor" aria-busy={pending}>
    <div className="photo-editor-heading"><Camera size={17} aria-hidden="true" /><span>Profile photo</span></div>
    <div className="photo-editor-content">
      {bitmap ? <canvas ref={canvas} className="photo-crop" aria-label="Profile photo crop preview" role="img" /> : <Avatar userId={userId} name={name} path={path} className="photo-current" />}
      <div className="photo-editor-options"><p>{bitmap ? 'Make it yours. Adjust the crop before saving.' : 'A familiar face makes it easier to say hello.'}</p>
        <input ref={file} hidden aria-label="Choose profile photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={pending || disabled} onChange={e => { const selected = e.target.files?.[0]; e.target.value = ''; choose(selected); }} />
        {bitmap && <div className="photo-sliders">
          <label>Zoom<input type="range" min="1" max="3" step="0.05" value={zoom} disabled={pending || disabled} onChange={e => setZoom(Number(e.target.value))} /></label>
          <label>Left / right<input type="range" min="0" max="100" value={horizontal} disabled={pending || disabled} onChange={e => setHorizontal(Number(e.target.value))} /></label>
          <label>Up / down<input type="range" min="0" max="100" value={vertical} disabled={pending || disabled} onChange={e => setVertical(Number(e.target.value))} /></label>
        </div>}
        <div className="photo-actions">
          {bitmap ? <><button type="button" className="primary" disabled={pending || disabled} onClick={() => save()}>{pending ? 'Saving…' : 'Save photo'}</button><button type="button" className="text-button" disabled={pending || disabled} onClick={() => { setBitmap(null); setError(''); }}>Cancel</button></> : <><button type="button" className="account" disabled={pending || disabled} onClick={() => file.current.click()}>{pending ? 'Please wait…' : path ? 'Change photo' : 'Choose photo'}</button>{path && <button type="button" className="text-button" disabled={pending || disabled} onClick={() => save(true)}>Remove photo</button>}</>}
        </div><small>JPG, PNG or WebP · up to 8 MB. Visible to signed-in members.</small>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="photo-status" role="status">{message}</p>}
  </div>;
}

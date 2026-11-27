export const PHOTO_BUCKET = 'profile-photos';
export const PHOTO_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

export function photoError(error) {
  if (error?.photoMessage) return error.photoMessage;
  if (error?.code === '40001') return 'Your photo changed in another tab. Refresh this page and try again.';
  if (error?.code === '42501' || String(error?.statusCode) === '403') return 'Sign in with a verified account and complete your profile before changing your photo.';
  return 'Couldn’t save your photo. Check your connection and try again.';
}

export function createAvatarApi(client) {
  const urls = new Map();
  const storage = () => { if (!client) throw new Error('Photos unavailable'); return client.storage.from(PHOTO_BUCKET); };
  const remove = async paths => { if (paths.length) await storage().remove(paths); };
  async function cleanup(userId, keep) {
    try {
      const { data, error } = await storage().list(userId, { limit: 100 });
      if (error) return;
      await remove((data || []).map(file => `${userId}/${file.name}`).filter(path => PHOTO_PATH.test(path) && path !== keep));
    } catch { /* Cleanup can be retried on the next upload; current photos are protected by RLS. */ }
  }
  return {
    invalidate: path => urls.delete(path),
    async url(path) {
      if (!PHOTO_PATH.test(path || '')) return null;
      if (urls.get(path)?.expires > Date.now()) return urls.get(path).promise;
      const promise = storage().createSignedUrl(path, 300).then(({ data, error }) => {
        if (error) throw error; return data.signedUrl;
      }).catch(error => { urls.delete(path); throw error; });
      urls.set(path, { promise, expires: Date.now() + 240_000 });
      return promise;
    },
    async save(userId, blob, previous = null) {
      if (!/^[0-9a-f-]{36}$/.test(userId) || (blob && (blob.type !== 'image/jpeg' || blob.size < 1 || blob.size > 524288))) throw new Error('Invalid photo');
      let next = null;
      if (blob) {
        await cleanup(userId, previous);
        next = `${userId}/${crypto.randomUUID()}.jpg`;
        const { error } = await storage().upload(next, blob, { contentType: 'image/jpeg', cacheControl: '60', upsert: false });
        if (error) throw error;
      }
      try {
        const { error } = await client.rpc('profile_set_avatar', { next_path: next, expected_path: previous });
        if (error) throw error;
      } catch (error) {
        // If a network error hides a committed save, RLS refuses to delete the active photo.
        if (next) { try { await remove([next]); } catch {} }
        throw error;
      }
      urls.delete(previous);
      await cleanup(userId, next);
      return next;
    },
  };
}

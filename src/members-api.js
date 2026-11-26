export function memberError(error) {
  if (error?.code === '42501') return 'This action is unavailable. The member may have changed their privacy settings, or your profile needs verification.';
  if (error?.code === '22023') return 'This request has changed or a field is invalid. Refresh and try again.';
  if (error?.code === 'P0001') return 'Please wait before sending more requests. You can request the same person again after seven days.';
  return 'Couldn’t complete that request. Check your connection and try again.';
}

export function createMembersApi(client) {
  async function rpc(name, args) {
    if (!client) throw new Error('Members unavailable');
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  return {
    list: (search = '', section = 'discover', page = 0) => rpc('social_directory', { search_text: search, section, page_number: page }),
    act: (peer, action) => rpc('social_friend_action', { peer_id: peer, action }),
    save: details => rpc('social_save_profile', {
      bio: details.bio, interests: details.interests, languages: details.languages,
      discoverable: details.discoverable, allow_requests: details.allow_requests,
    }),
    watch(userId, changed) {
      if (!client) return () => {};
      const channel = client.channel(`friends:${userId}:${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, changed)
        .subscribe(status => { if (status === 'SUBSCRIBED') changed(); });
      return () => { client.removeChannel(channel); };
    },
  };
}

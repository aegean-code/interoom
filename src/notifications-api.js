export function createNotificationsApi(client) {
  async function rpc(name, args) {
    if (!client) throw new Error('Notifications unavailable');
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  return {
    list: (page = 0) => rpc('notice_inbox', { page_number: page }),
    rooms: () => rpc('notice_room_counts'),
    read: notice => rpc('notice_mark_read', { notice_id: notice.id, expected_version: notice.version }),
    readAll: snapshot => rpc('notice_mark_all_read', { through_time: snapshot }),
    readRoom: (room, view, entry) => rpc('notice_read_room', { room, room_view: view, through_entry: entry }),
    watch(userId, onChange, onStatus) {
      if (!client) return () => {};
      const channel = client.channel(`notifications:${userId}:${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'room_activity' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'room_reads', filter: `user_id=eq.${userId}` }, onChange)
        .subscribe(onStatus);
      return () => { client.removeChannel(channel); };
    },
  };
}

export function notificationLabel(notice) {
  const action = { dm: 'sent you a private message', reply: 'replied to your post', reaction: 'liked your post', mention: 'mentioned you', friend_request: 'sent you a friend request', friend_accepted: 'accepted your friend request' }[notice.kind] || 'shared an update';
  return `${notice.name || 'A member'} ${action}`;
}

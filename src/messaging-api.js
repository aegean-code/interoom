export function mergeMessages(existing, incoming) {
  const rows = new Map(existing.map(message => [message.id, message]));
  for (const message of incoming) {
    // A delayed INSERT/refresh must never resurrect a deleted message.
    if (!rows.get(message.id)?.deleted_at || message.deleted_at) rows.set(message.id, message);
  }
  return [...rows.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence));
}

export function messagingError(error) {
  if (error?.code === '42501') return 'This action is unavailable. Check your email verification, profile, and messaging permissions.';
  if (error?.code === '22023') return 'Check your message or selection and try again.';
  if (error?.code === 'P0001') return 'You’ve reached the messaging limit. Wait a little before trying again.';
  return 'Couldn’t complete that request. Check your connection and try again.';
}

export function createMessagingApi(client) {
  async function rpc(name, args) {
    if (!client) throw new Error('Messaging unavailable');
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  return {
    inbox: (page = 0) => rpc('dm_inbox', { page_number: page }),
    conversation: async id => (await rpc('dm_inbox', { page_number: 0, conversation_filter: id })).items[0] || null,
    search: text => rpc('dm_search_members', { search_text: text }),
    start: peer => rpc('dm_start_conversation', { peer_id: peer }),
    messages: async (conversation, before = null) => (await rpc('dm_get_messages', { conversation, before_sequence: before })).reverse(),
    send: async (conversation, body, nonce) => {
      const result = await rpc('dm_send_message', { conversation, message_body: body, nonce });
      return Array.isArray(result) ? result[0] : result;
    },
    read: (conversation, message) => rpc('dm_mark_read', { conversation, through_message: message }),
    remove: message => rpc('dm_delete_message', { message_id: message }),
    block: (peer, blocked) => rpc('dm_set_block', { peer_id: peer, blocked }),
    report: (message, reason) => rpc('dm_report_message', { message_id: message, report_reason: reason }),
    preferences: (allowNew, showOnline) => rpc('dm_set_preferences', { allow_new: allowNew, show_online: showOnline }),
    heartbeat: () => rpc('dm_heartbeat'),
    watch(userId, onChange, onStatus) {
      if (!client) return () => {};
      let channel = client.channel(`private-messages:${userId}:${crypto.randomUUID()}`);
      for (const table of ['dm_conversations', 'dm_messages', 'dm_reads', 'dm_presence']) {
        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => onChange({ table, ...payload }));
      }
      channel.subscribe(onStatus);
      return () => { client.removeChannel(channel); };
    },
  };
}

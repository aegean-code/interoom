begin;

-- Existing accounts and community content are unchanged.
alter table public.profiles add column username text
  check (username is null or username ~ '^[a-z][a-z0-9_]{2,23}$');
create unique index profiles_username_unique on public.profiles (username) where username is not null;
grant insert (username), update (username) on public.profiles to authenticated;

create table public.dm_conversations (
  id uuid primary key default gen_random_uuid(),
  user_low uuid not null references public.profiles(id),
  user_high uuid not null references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  last_activity_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (user_low < user_high),
  check (created_by in (user_low, user_high)),
  unique(user_low, user_high)
);
create index dm_conversations_high_idx on public.dm_conversations(user_high, last_activity_at desc);
create index dm_conversations_low_idx on public.dm_conversations(user_low, last_activity_at desc);
create index dm_conversations_creator_idx on public.dm_conversations(created_by, created_at desc);

create table public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  conversation_id uuid not null references public.dm_conversations(id),
  sender_id uuid not null references public.profiles(id),
  client_nonce uuid not null,
  body text,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  check ((deleted_at is null and body is not null and char_length(trim(body)) between 1 and 4000)
    or (deleted_at is not null and body is null)),
  unique(sender_id, client_nonce)
);
create index dm_messages_conversation_idx on public.dm_messages(conversation_id, sequence desc);
create index dm_messages_sender_idx on public.dm_messages(sender_id, created_at desc);

create table public.dm_reads (
  conversation_id uuid not null references public.dm_conversations(id),
  user_id uuid not null references public.profiles(id),
  last_read_sequence bigint not null default 0 check(last_read_sequence >= 0),
  primary key(conversation_id, user_id)
);
create index dm_reads_user_idx on public.dm_reads(user_id);
create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id),
  blocked_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(blocker_id, blocked_id), check(blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on public.user_blocks(blocked_id);
create table public.dm_preferences (
  user_id uuid primary key references public.profiles(id),
  allow_new_conversations boolean not null default true
);
create table public.dm_presence (
  user_id uuid primary key references public.profiles(id),
  enabled boolean not null default false,
  last_active_at timestamptz
);
create table interoom_private.dm_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id),
  message_id uuid not null references public.dm_messages(id),
  reported_user_id uuid not null references public.profiles(id),
  message_snapshot text not null,
  reason text not null check(char_length(trim(reason)) between 2 and 500),
  created_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending' check(status in ('pending','reviewed')),
  unique(reporter_id,message_id)
);
create index dm_reports_message_idx on interoom_private.dm_reports(message_id);
create index dm_reports_reported_user_idx on interoom_private.dm_reports(reported_user_id);

alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_reads enable row level security;
alter table public.user_blocks enable row level security;
alter table public.dm_preferences enable row level security;
alter table public.dm_presence enable row level security;
alter table interoom_private.dm_reports enable row level security;
revoke all on public.dm_conversations,public.dm_messages,public.dm_reads,public.user_blocks,
  public.dm_preferences,public.dm_presence,interoom_private.dm_reports from public,anon,authenticated;
grant select on public.dm_conversations,public.dm_messages,public.dm_reads,public.user_blocks,
  public.dm_preferences,public.dm_presence to authenticated;
grant usage on schema interoom_private to authenticated;

-- Privileged implementations live outside the exposed API schema. Every entry
-- point derives identity from auth.uid(), never from editable JWT metadata.
create function interoom_private.dm_is_member() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=(select auth.uid()) and u.email_confirmed_at is not null
      and u.deleted_at is null and not coalesce(u.is_anonymous,false));
$$;
create function interoom_private.dm_require_member() returns uuid
language plpgsql stable security definer set search_path='' as $$
begin
  if not interoom_private.dm_is_member() then
    raise exception 'Verify your email and complete your profile to use messages.' using errcode='42501';
  end if;
  return auth.uid();
end;
$$;
create function interoom_private.dm_blocked(peer_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.user_blocks b
    where (b.blocker_id=auth.uid() and b.blocked_id=peer_id)
       or (b.blocker_id=peer_id and b.blocked_id=auth.uid()));
$$;
create function interoom_private.dm_can_read(conversation uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select interoom_private.dm_is_member() and exists(select 1 from public.dm_conversations c
    where c.id=conversation and auth.uid() in (c.user_low,c.user_high));
$$;
create function interoom_private.dm_peer_visible(peer_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select interoom_private.dm_is_member() and not interoom_private.dm_blocked(peer_id)
    and exists(select 1 from public.dm_conversations c
      where (c.user_low=auth.uid() and c.user_high=peer_id) or (c.user_high=auth.uid() and c.user_low=peer_id));
$$;

create policy dm_conversation_participants on public.dm_conversations for select to authenticated
  using ((select interoom_private.dm_is_member()) and (select auth.uid()) in (user_low,user_high));
create policy dm_message_participants on public.dm_messages for select to authenticated
  using (interoom_private.dm_can_read(conversation_id));
create policy dm_read_receipts on public.dm_reads for select to authenticated
  using (interoom_private.dm_can_read(conversation_id) and
    (user_id=(select auth.uid()) or not interoom_private.dm_blocked(user_id)));
create policy dm_own_blocks on public.user_blocks for select to authenticated
  using ((select interoom_private.dm_is_member()) and blocker_id=(select auth.uid()));
create policy dm_own_preferences on public.dm_preferences for select to authenticated
  using ((select interoom_private.dm_is_member()) and user_id=(select auth.uid()));
create policy dm_opted_in_presence on public.dm_presence for select to authenticated
  using ((user_id=(select auth.uid()) and (select interoom_private.dm_is_member()))
    or (enabled and interoom_private.dm_peer_visible(user_id)));

create function interoom_private.dm_search_members(search_text text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); term text := lower(trim(search_text));
begin
  if term is null or char_length(term)<2 then return '[]'::jsonb; end if;
  if char_length(term)>80 then raise exception 'Search is too long' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(p)) from (
    select p.id,p.name,p.username from public.profiles p join auth.users u on u.id=p.id
    left join public.dm_preferences pref on pref.user_id=p.id
    where p.id<>actor and u.email_confirmed_at is not null and u.deleted_at is null
      and not coalesce(u.is_anonymous,false) and coalesce(pref.allow_new_conversations,true)
      and not interoom_private.dm_blocked(p.id)
      and (strpos(lower(p.name),term)>0 or strpos(p.username,ltrim(term,'@'))>0)
    order by p.name,p.id limit 25
  ) p),'[]'::jsonb);
end;
$$;

create function interoom_private.dm_start_conversation(peer_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); conversation uuid;
begin
  if peer_id is null or peer_id=actor then raise exception 'Choose another member' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dm-rate:'||actor::text,0));
  perform pg_advisory_xact_lock(hashtextextended('dm-pair:'||least(actor,peer_id)::text||greatest(actor,peer_id)::text,0));
  if interoom_private.dm_blocked(peer_id) or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=peer_id and u.email_confirmed_at is not null and u.deleted_at is null and not coalesce(u.is_anonymous,false))
    then raise exception 'This member is unavailable for messages.' using errcode='42501'; end if;
  select id into conversation from public.dm_conversations where user_low=least(actor,peer_id) and user_high=greatest(actor,peer_id);
  if conversation is not null then return conversation; end if;
  if exists(select 1 from public.dm_preferences where user_id=peer_id and not allow_new_conversations) then
    raise exception 'This member is unavailable for messages.' using errcode='42501'; end if;
  if (select count(*) from public.dm_conversations where created_by=actor and created_at>clock_timestamp()-interval '1 hour')>=10 then
    raise exception 'Too many new conversations. Please try again later.' using errcode='P0001'; end if;
  insert into public.dm_conversations(user_low,user_high,created_by) values(least(actor,peer_id),greatest(actor,peer_id),actor) returning id into conversation;
  return conversation;
end;
$$;

create function interoom_private.dm_send_message(conversation uuid, message_body text, nonce uuid) returns public.dm_messages
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); peer uuid; sent public.dm_messages;
begin
  if message_body is null or char_length(trim(message_body)) not between 1 and 4000 or nonce is null then
    raise exception 'Messages must contain 1–4000 characters.' using errcode='22023'; end if;
  select case when user_low=actor then user_high else user_low end into peer from public.dm_conversations
    where id=conversation and actor in (user_low,user_high);
  if peer is null then raise exception 'Conversation unavailable.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dm-rate:'||actor::text,0));
  perform pg_advisory_xact_lock(hashtextextended('dm-pair:'||least(actor,peer)::text||greatest(actor,peer)::text,0));
  if interoom_private.dm_blocked(peer) or not exists(select 1 from auth.users where id=peer and deleted_at is null) then
    raise exception 'Messages are unavailable for this conversation.' using errcode='42501'; end if;
  select * into sent from public.dm_messages where sender_id=actor and client_nonce=nonce;
  if found then
    if sent.conversation_id<>conversation or (sent.deleted_at is null and sent.body<>trim(message_body)) then
      raise exception 'Message retry does not match.' using errcode='22023'; end if;
    return sent;
  end if;
  if (select count(*) from public.dm_messages where sender_id=actor and created_at>clock_timestamp()-interval '1 minute')>=30
    or (select count(*) from public.dm_messages where sender_id=actor and created_at>clock_timestamp()-interval '1 day')>=1000 then
    raise exception 'You are sending too quickly. Please wait before trying again.' using errcode='P0001'; end if;
  insert into public.dm_messages(conversation_id,sender_id,client_nonce,body)
    values(conversation,actor,nonce,trim(message_body)) returning * into sent;
  update public.dm_conversations set last_activity_at=sent.created_at,updated_at=clock_timestamp() where id=conversation;
  return sent;
end;
$$;

create function interoom_private.dm_mark_read(conversation uuid, through_message uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); marker bigint; peer uuid;
begin
  if not interoom_private.dm_can_read(conversation) then raise exception 'Conversation unavailable.' using errcode='42501'; end if;
  select case when user_low=actor then user_high else user_low end into peer from public.dm_conversations where id=conversation;
  select sequence into marker from public.dm_messages where id=through_message and conversation_id=conversation;
  if marker is null then raise exception 'Message unavailable.' using errcode='22023'; end if;
  insert into public.dm_reads(conversation_id,user_id,last_read_sequence) values(conversation,actor,marker)
    on conflict(conversation_id,user_id) do update set last_read_sequence=greatest(public.dm_reads.last_read_sequence,excluded.last_read_sequence);
end;
$$;

create function interoom_private.dm_delete_message(message_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); conversation uuid;
begin
  update public.dm_messages set body=null,deleted_at=clock_timestamp()
    where id=message_id and sender_id=actor and deleted_at is null returning conversation_id into conversation;
  if conversation is null and not exists(select 1 from public.dm_messages where id=message_id and sender_id=actor) then
    raise exception 'You can only delete your own messages.' using errcode='42501'; end if;
  update public.dm_conversations set updated_at=clock_timestamp() where id=conversation;
end;
$$;

create function interoom_private.dm_set_block(peer_id uuid, blocked boolean) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member();
begin
  if peer_id is null or peer_id=actor or blocked is null then raise exception 'Choose another member' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dm-pair:'||least(actor,peer_id)::text||greatest(actor,peer_id)::text,0));
  if blocked then insert into public.user_blocks(blocker_id,blocked_id) values(actor,peer_id) on conflict do nothing;
  else delete from public.user_blocks where blocker_id=actor and blocked_id=peer_id; end if;
  update public.dm_conversations set updated_at=clock_timestamp()
    where user_low=least(actor,peer_id) and user_high=greatest(actor,peer_id);
end;
$$;

create function interoom_private.dm_report_message(message_id uuid, report_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); target public.dm_messages;
begin
  if report_reason is null or char_length(trim(report_reason)) not between 2 and 500 then raise exception 'Describe the problem in 2–500 characters.' using errcode='22023'; end if;
  select * into target from public.dm_messages where id=message_id and deleted_at is null and sender_id<>actor;
  if not found or not interoom_private.dm_can_read(target.conversation_id) then raise exception 'Message unavailable.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dm-report:'||actor::text,0));
  if exists(select 1 from interoom_private.dm_reports where reporter_id=actor and dm_reports.message_id=target.id) then return; end if;
  if (select count(*) from interoom_private.dm_reports where reporter_id=actor and created_at>clock_timestamp()-interval '1 hour')>=10 then
    raise exception 'Too many reports. Please try again later.' using errcode='P0001'; end if;
  insert into interoom_private.dm_reports(reporter_id,message_id,reported_user_id,message_snapshot,reason)
    values(actor,target.id,target.sender_id,target.body,trim(report_reason));
end;
$$;

create function interoom_private.dm_set_preferences(allow_new boolean, show_online boolean) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member();
begin
  if allow_new is null or show_online is null then raise exception 'Choose your preferences' using errcode='22023'; end if;
  insert into public.dm_preferences(user_id,allow_new_conversations) values(actor,allow_new)
    on conflict(user_id) do update set allow_new_conversations=excluded.allow_new_conversations;
  insert into public.dm_presence(user_id,enabled,last_active_at) values(actor,show_online,case when show_online then clock_timestamp() end)
    on conflict(user_id) do update set enabled=excluded.enabled,last_active_at=excluded.last_active_at;
end;
$$;
create function interoom_private.dm_heartbeat() returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member();
begin
  update public.dm_presence set last_active_at=clock_timestamp() where user_id=actor and enabled
    and (last_active_at is null or last_active_at<clock_timestamp()-interval '30 seconds');
end;
$$;

create function interoom_private.dm_inbox(page_number integer default 0, conversation_filter uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); result jsonb;
begin
  if page_number is null or page_number<0 or page_number>100000 then raise exception 'Invalid inbox page' using errcode='22023'; end if;
  with mine as materialized (
    select c.*,case when c.user_low=actor then c.user_high else c.user_low end as peer_id
    from public.dm_conversations c where actor in(c.user_low,c.user_high)
  ), unread as (
    select c.id,count(m.id) as count from mine c left join public.dm_reads r on r.conversation_id=c.id and r.user_id=actor
    left join public.dm_messages m on m.conversation_id=c.id and m.sender_id<>actor and m.deleted_at is null and m.sequence>coalesce(r.last_read_sequence,0)
    group by c.id
  ), items as (
    select c.id,c.last_activity_at,p.id as peer_id,p.name,p.username,
      (select to_jsonb(m) from public.dm_messages m where m.conversation_id=c.id order by m.sequence desc limit 1) as last_message,
      u.count as unread_count,
      not interoom_private.dm_blocked(p.id) as can_message,
      exists(select 1 from public.user_blocks b where b.blocker_id=actor and b.blocked_id=p.id) as blocked_by_me,
      case when presence.enabled and not interoom_private.dm_blocked(p.id) then presence.last_active_at>now()-interval '90 seconds' end as is_online,
      case when not interoom_private.dm_blocked(p.id) then coalesce(r.last_read_sequence,0) else 0 end as peer_read_sequence
    from mine c join public.profiles p on p.id=c.peer_id join unread u on u.id=c.id
    left join public.dm_reads r on r.conversation_id=c.id and r.user_id=p.id
    left join public.dm_presence presence on presence.user_id=p.id
    where conversation_filter is null or c.id=conversation_filter
    order by c.last_activity_at desc,c.id limit 50 offset page_number::bigint*50
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by i.last_activity_at desc,i.id) from items i),'[]'::jsonb),
    'total',(select count(*) from mine),'unread_count',coalesce((select sum(count) from unread),0),
    'page',page_number,'page_size',50,'preferences',jsonb_build_object(
      'allow_new',coalesce((select allow_new_conversations from public.dm_preferences where user_id=actor),true),
      'show_online',coalesce((select enabled from public.dm_presence where user_id=actor),false))) into result;
  return result;
end;
$$;

-- Thin invoker wrappers expose only the explicitly guarded operations.
create function public.dm_search_members(search_text text) returns jsonb language sql stable security invoker set search_path='' as $$ select interoom_private.dm_search_members(search_text); $$;
create function public.dm_start_conversation(peer_id uuid) returns uuid language sql security invoker set search_path='' as $$ select interoom_private.dm_start_conversation(peer_id); $$;
create function public.dm_send_message(conversation uuid,message_body text,nonce uuid) returns public.dm_messages language sql security invoker set search_path='' as $$ select interoom_private.dm_send_message(conversation,message_body,nonce); $$;
create function public.dm_mark_read(conversation uuid,through_message uuid) returns void language sql security invoker set search_path='' as $$ select interoom_private.dm_mark_read(conversation,through_message); $$;
create function public.dm_delete_message(message_id uuid) returns void language sql security invoker set search_path='' as $$ select interoom_private.dm_delete_message(message_id); $$;
create function public.dm_set_block(peer_id uuid,blocked boolean) returns void language sql security invoker set search_path='' as $$ select interoom_private.dm_set_block(peer_id,blocked); $$;
create function public.dm_report_message(message_id uuid,report_reason text) returns void language sql security invoker set search_path='' as $$ select interoom_private.dm_report_message(message_id,report_reason); $$;
create function public.dm_set_preferences(allow_new boolean,show_online boolean) returns void language sql security invoker set search_path='' as $$ select interoom_private.dm_set_preferences(allow_new,show_online); $$;
create function public.dm_heartbeat() returns void language sql security invoker set search_path='' as $$ select interoom_private.dm_heartbeat(); $$;
create function public.dm_inbox(page_number integer default 0, conversation_filter uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$ select interoom_private.dm_inbox(page_number,conversation_filter); $$;
create function public.dm_get_messages(conversation uuid,before_sequence bigint default null) returns setof public.dm_messages
language sql stable security invoker set search_path='' as $$
  select * from public.dm_messages where conversation_id=conversation and (before_sequence is null or sequence<before_sequence)
  order by sequence desc limit 50;
$$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','interoom_private') and p.proname like 'dm\_%' escape '\'
  loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;

-- Use UPDATE tombstones rather than DELETE: Realtime can apply participant RLS
-- to updates; delete events cannot be filtered safely in the same way.
alter publication supabase_realtime add table public.dm_conversations,public.dm_messages,public.dm_reads,public.dm_presence;
commit;

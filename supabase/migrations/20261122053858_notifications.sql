begin;

-- Activity metadata only: never copy private message bodies into notifications.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  kind text not null check(kind in ('dm','reply','reaction','mention')),
  event_key text not null,
  post_id uuid,
  reply_id uuid,
  conversation_id uuid references public.dm_conversations(id),
  message_sequence bigint,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version bigint not null default 1,
  read_at timestamptz,
  unavailable boolean not null default false,
  check(recipient_id<>actor_id),
  unique(recipient_id,event_key)
);
create index notifications_recipient_recent_idx on public.notifications(recipient_id,updated_at desc,id);
create index notifications_rate_idx on public.notifications(recipient_id,actor_id,created_at desc);
create index notifications_actor_idx on public.notifications(actor_id);
create index notifications_conversation_idx on public.notifications(conversation_id);
create index notifications_post_idx on public.notifications(post_id);
create index notifications_reply_idx on public.notifications(reply_id);

-- Begin tracking new room activity at rollout. Existing content is not backfilled.
create table public.room_activity (
  sequence bigint generated always as identity primary key,
  room_id text not null references public.rooms(id),
  view text not null check(view in ('posts','chat')),
  entry_id uuid not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  active boolean not null default true,
  unique(view,entry_id)
);
create index room_activity_unread_idx on public.room_activity(room_id,view,sequence);
create index room_activity_actor_idx on public.room_activity(actor_id);
create table public.room_reads (
  user_id uuid not null references public.profiles(id),
  room_id text not null references public.rooms(id),
  view text not null check(view in ('posts','chat')),
  last_read_sequence bigint not null check(last_read_sequence>=0),
  primary key(user_id,room_id,view)
);
create index room_reads_room_idx on public.room_reads(room_id);

alter table public.notifications enable row level security;
alter table public.room_activity enable row level security;
alter table public.room_reads enable row level security;
revoke all on public.notifications,public.room_activity,public.room_reads from public,anon,authenticated;
grant select on public.notifications,public.room_activity,public.room_reads to authenticated;
create policy notifications_recipient on public.notifications for select to authenticated
  using(recipient_id=(select auth.uid()) and (select interoom_private.dm_is_member()));
create policy room_activity_members on public.room_activity for select to authenticated
  using((select interoom_private.dm_is_member()));
create policy room_reads_owner on public.room_reads for select to authenticated
  using(user_id=(select auth.uid()) and (select interoom_private.dm_is_member()));

create function interoom_private.notice_add(actor uuid,recipient uuid,notice_kind text,dedupe_key text,
  post uuid default null,reply uuid default null,conversation uuid default null,message_seq bigint default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if actor is distinct from auth.uid() or recipient is null or recipient=actor
    or not interoom_private.dm_is_member()
    or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=recipient and u.email_confirmed_at is not null and u.deleted_at is null and not coalesce(u.is_anonymous,false))
    or exists(select 1 from public.user_blocks b where
      (b.blocker_id=actor and b.blocked_id=recipient) or (b.blocker_id=recipient and b.blocked_id=actor)) then return; end if;
  -- One actor lock avoids inverted recipient locks in multi-mention posts.
  perform pg_advisory_xact_lock(hashtextextended('notice-actor:'||actor::text,0));
  if notice_kind='dm' then
    insert into public.notifications(recipient_id,actor_id,kind,event_key,conversation_id,message_sequence)
      values(recipient,actor,notice_kind,dedupe_key,conversation,message_seq)
      on conflict(recipient_id,event_key) do update set message_sequence=excluded.message_sequence,
        updated_at=clock_timestamp(),version=public.notifications.version+1,read_at=null,unavailable=false;
  elsif not exists(select 1 from public.notifications n where n.recipient_id=recipient and n.event_key=dedupe_key) then
    -- Limits affect notifications only; the underlying post/reply still succeeds.
    if (select count(*) from public.notifications n where n.recipient_id=recipient and n.actor_id=actor
        and n.created_at>clock_timestamp()-interval '1 hour')>=20
      or (select count(*) from public.notifications n where n.recipient_id=recipient
        and n.created_at>clock_timestamp()-interval '1 day')>=200 then return; end if;
    insert into public.notifications(recipient_id,actor_id,kind,event_key,post_id,reply_id)
      values(recipient,actor,notice_kind,dedupe_key,post,reply) on conflict do nothing;
  end if;
end;
$$;

create function interoom_private.notice_mentions(actor uuid,body text,post uuid,reply uuid default null,exclude_user uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare recipient uuid;
begin
  for recipient in select p.id from public.profiles p join (
    select distinct lower(m[2]) as username from regexp_matches(body,'(^|[^a-z0-9_@])@([a-z][a-z0-9_]{2,23})(?![a-z0-9_])','gi') m
    order by username limit 5
  ) mentions on mentions.username=p.username where p.id is distinct from exclude_user
  loop
    perform interoom_private.notice_add(actor,recipient,'mention','mention:'||coalesce(reply,post)::text,post,reply);
  end loop;
end;
$$;

create function interoom_private.notice_community_activity() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  if tg_op='DELETE' then
    if tg_table_name='posts' then
      update public.notifications set unavailable=true,read_at=coalesce(read_at,clock_timestamp()) where post_id=old.id;
      update public.room_activity set active=false where view='posts' and entry_id=old.id;
    elsif tg_table_name='replies' then
      update public.notifications set unavailable=true,read_at=coalesce(read_at,clock_timestamp()) where reply_id=old.id;
    elsif tg_table_name='messages' then
      update public.room_activity set active=false where view='chat' and entry_id=old.id;
    end if;
    return old;
  end if;
  if tg_table_name in ('posts','messages') then
    insert into public.room_activity(room_id,view,entry_id,actor_id)
      values(new.room_id,case when tg_table_name='posts' then 'posts' else 'chat' end,new.id,new.author_id);
    if tg_table_name='posts' then perform interoom_private.notice_mentions(new.author_id,new.body,new.id); end if;
  else
    select author_id into owner_id from public.posts where id=new.post_id;
    if tg_table_name='replies' then
      perform interoom_private.notice_add(new.author_id,owner_id,'reply','reply:'||new.id::text,new.post_id,new.id);
      perform interoom_private.notice_mentions(new.author_id,new.body,new.post_id,new.id,owner_id);
    else
      perform interoom_private.notice_add(new.author_id,owner_id,'reaction','reaction:'||new.post_id::text||':'||new.author_id::text,new.post_id);
    end if;
  end if;
  return new;
end;
$$;
create trigger notify_posts after insert or delete on public.posts for each row execute function interoom_private.notice_community_activity();
create trigger notify_replies after insert or delete on public.replies for each row execute function interoom_private.notice_community_activity();
create trigger notify_reactions after insert on public.reactions for each row execute function interoom_private.notice_community_activity();
create trigger track_room_chat after insert or delete on public.messages for each row execute function interoom_private.notice_community_activity();

create function interoom_private.notice_direct_message() returns trigger
language plpgsql security definer set search_path='' as $$
declare recipient uuid; unread_sequence bigint;
begin
  select case when user_low=new.sender_id then user_high else user_low end into recipient
    from public.dm_conversations where id=new.conversation_id;
  if tg_op='INSERT' then
    perform interoom_private.notice_add(new.sender_id,recipient,'dm','dm:'||new.conversation_id::text,null,null,new.conversation_id,new.sequence);
  elsif old.deleted_at is null and new.deleted_at is not null then
    select max(m.sequence) into unread_sequence from public.dm_messages m
      left join public.dm_reads r on r.conversation_id=m.conversation_id and r.user_id=recipient
      where m.conversation_id=new.conversation_id and m.sender_id<>recipient and m.deleted_at is null
        and m.sequence>coalesce(r.last_read_sequence,0);
    update public.notifications set message_sequence=coalesce(unread_sequence,message_sequence),version=version+1,
      read_at=case when unread_sequence is null then coalesce(read_at,clock_timestamp()) else read_at end,
      unavailable=not exists(select 1 from public.dm_messages m where m.conversation_id=new.conversation_id and m.sender_id<>recipient and m.deleted_at is null)
      where recipient_id=recipient and conversation_id=new.conversation_id;
  end if;
  return new;
end;
$$;
create trigger notify_dm after insert or update of deleted_at on public.dm_messages
  for each row execute function interoom_private.notice_direct_message();

create function interoom_private.notice_receipt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.notifications set read_at=clock_timestamp()
    where recipient_id=new.user_id and conversation_id=new.conversation_id and read_at is null and message_sequence<=new.last_read_sequence;
  return new;
end;
$$;
create trigger read_dm_notice after insert or update on public.dm_reads for each row execute function interoom_private.notice_receipt();

create function interoom_private.notice_inbox(page_number integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); result jsonb;
begin
  if page_number is null or page_number<0 or page_number>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
  with mine as materialized (
    select n.* from public.notifications n where recipient_id=actor and not interoom_private.dm_blocked(n.actor_id)
  ), items as (
    select n.id,n.kind,n.post_id,n.reply_id,n.conversation_id,n.updated_at,n.version,n.read_at,n.unavailable,p.name,p.username,post.room_id
    from mine n join public.profiles p on p.id=n.actor_id left join public.posts post on post.id=n.post_id
    order by n.updated_at desc,n.id limit 30 offset page_number::bigint*30
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by i.updated_at desc,i.id) from items i),'[]'::jsonb),
    'unread_count',(select count(*) from mine where read_at is null and not unavailable),'total',(select count(*) from mine),
    'snapshot_at',statement_timestamp()) into result;
  return result;
end;
$$;
create function interoom_private.notice_mark_read(notice_id uuid,expected_version bigint) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member();
begin
  update public.notifications set read_at=coalesce(read_at,clock_timestamp())
    where id=notice_id and recipient_id=actor and version=expected_version;
end;
$$;
create function interoom_private.notice_mark_all_read(through_time timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member();
begin
  if through_time is null or through_time>clock_timestamp() then raise exception 'Invalid snapshot' using errcode='22023'; end if;
  update public.notifications set read_at=clock_timestamp()
    where recipient_id=actor and read_at is null and updated_at<=through_time;
end;
$$;
create function interoom_private.notice_room_counts() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); result jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into result from (
    select e.room_id,e.view,count(*) as unread_count from public.room_activity e
      left join public.room_reads r on r.user_id=actor and r.room_id=e.room_id and r.view=e.view
      where e.active and e.actor_id<>actor and e.sequence>coalesce(r.last_read_sequence,0)
        and not interoom_private.dm_blocked(e.actor_id)
        and e.created_at>=(select created_at from auth.users where id=actor)
      group by e.room_id,e.view
  ) r;
  return result;
end;
$$;
create function interoom_private.notice_read_room(room text,room_view text,through_entry uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); marker bigint;
begin
  if room_view not in ('posts','chat') or room_view is null then raise exception 'Invalid view' using errcode='22023'; end if;
  select sequence into marker from public.room_activity where room_id=room and view=room_view and entry_id=through_entry;
  if marker is null then return; end if;
  insert into public.room_reads(user_id,room_id,view,last_read_sequence) values(actor,room,room_view,marker)
    on conflict(user_id,room_id,view) do update set last_read_sequence=greatest(public.room_reads.last_read_sequence,excluded.last_read_sequence);
end;
$$;

create function public.notice_inbox(page_number integer default 0) returns jsonb language sql stable security invoker set search_path='' as $$ select interoom_private.notice_inbox(page_number); $$;
create function public.notice_mark_read(notice_id uuid,expected_version bigint) returns void language sql security invoker set search_path='' as $$ select interoom_private.notice_mark_read(notice_id,expected_version); $$;
create function public.notice_mark_all_read(through_time timestamptz) returns void language sql security invoker set search_path='' as $$ select interoom_private.notice_mark_all_read(through_time); $$;
create function public.notice_room_counts() returns jsonb language sql stable security invoker set search_path='' as $$ select interoom_private.notice_room_counts(); $$;
create function public.notice_read_room(room text,room_view text,through_entry uuid) returns void language sql security invoker set search_path='' as $$ select interoom_private.notice_read_room(room,room_view,through_entry); $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','interoom_private') and p.proname like 'notice\_%' escape '\'
  loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    if f.proname in ('notice_inbox','notice_mark_read','notice_mark_all_read','notice_room_counts','notice_read_room') then
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
alter publication supabase_realtime add table public.notifications,public.room_activity,public.room_reads;
commit;

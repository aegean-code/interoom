begin;

create table public.member_details (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  bio text not null default '' check(char_length(bio)<=280),
  interests text not null default '' check(char_length(interests)<=160),
  languages text not null default '' check(char_length(languages)<=120),
  discoverable boolean not null default true,
  allow_requests boolean not null default true
);
create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_low uuid not null references public.profiles(id) on delete cascade,
  user_high uuid not null references public.profiles(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled','removed')),
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  check(user_low<user_high), check(requester_id in (user_low,user_high)),
  unique(user_low,user_high)
);
create index friendships_high_idx on public.friendships(user_high,status);
create index friendships_requester_idx on public.friendships(requester_id);
create table interoom_private.friend_request_events (
  id bigint generated always as identity primary key,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create index friend_request_events_actor_idx on interoom_private.friend_request_events(actor_id,created_at desc);
alter table public.member_details enable row level security;
alter table public.friendships enable row level security;
alter table interoom_private.friend_request_events enable row level security;
revoke all on public.member_details,public.friendships,interoom_private.friend_request_events from public,anon,authenticated;
grant select on public.member_details,public.friendships to authenticated;
create policy member_details_owner on public.member_details for select to authenticated
  using(user_id=(select auth.uid()) and (select interoom_private.dm_is_member()));
create policy friendships_participants on public.friendships for select to authenticated
  using((select interoom_private.dm_is_member()) and (select auth.uid()) in (user_low,user_high)
    and not interoom_private.dm_blocked(case when user_low=auth.uid() then user_high else user_low end));

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check(kind in ('dm','reply','reaction','mention','friend_request','friend_accepted'));

create function interoom_private.social_archive_notices(friendship uuid) returns void
language sql security definer set search_path='' as $$
  update public.notifications set unavailable=true,read_at=coalesce(read_at,clock_timestamp())
    where event_key like 'friend_request:'||friendship::text||':%'
       or event_key like 'friend_accepted:'||friendship::text||':%';
$$;

create function interoom_private.social_save_profile(bio text,interests text,languages text,discoverable boolean,allow_requests boolean) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member();
begin
  if bio is null or interests is null or languages is null or discoverable is null or allow_requests is null
    or char_length(bio)>280 or char_length(interests)>160 or char_length(languages)>120 then
    raise exception 'Check your profile fields.' using errcode='22023'; end if;
  insert into public.member_details(user_id,bio,interests,languages,discoverable,allow_requests)
    values(actor,trim(bio),trim(interests),trim(languages),discoverable,allow_requests)
    on conflict(user_id) do update set bio=excluded.bio,interests=excluded.interests,languages=excluded.languages,
      discoverable=excluded.discoverable,allow_requests=excluded.allow_requests;
end;
$$;

create function interoom_private.social_directory(search_text text default '',section text default 'discover',page_number integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); term text:=lower(trim(search_text)); result jsonb;
begin
  if term is null or char_length(term)>80 or section is null or section not in ('discover','friends','requests')
    or page_number is null or page_number<0 or page_number>100000 then
    raise exception 'Invalid search.' using errcode='22023'; end if;
  with visible as materialized (
    select p.id,p.name,p.username,p.country,p.school,coalesce(d.bio,'') as bio,
      coalesce(d.interests,'') as interests,coalesce(d.languages,'') as languages,
      coalesce(d.discoverable,true) as discoverable,coalesce(d.allow_requests,true) as allow_requests,
      (coalesce(pref.allow_new_conversations,true) or exists(select 1 from public.dm_conversations c
        where c.user_low=least(actor,p.id) and c.user_high=greatest(actor,p.id))) as can_message,
      case when f.status='accepted' then 'friends' when f.status='pending' then
        case when f.requester_id=actor then 'outgoing' else 'incoming' end else 'none' end as relationship
    from public.profiles p join auth.users u on u.id=p.id
    left join public.member_details d on d.user_id=p.id
    left join public.dm_preferences pref on pref.user_id=p.id
    left join public.friendships f on f.user_low=least(actor,p.id) and f.user_high=greatest(actor,p.id)
    where p.id<>actor and u.email_confirmed_at is not null and u.deleted_at is null and not coalesce(u.is_anonymous,false)
      and not interoom_private.dm_blocked(p.id)
      and (coalesce(d.discoverable,true) or f.status in ('pending','accepted'))
  ), filtered as (
    select * from visible where
      ((section='discover' and discoverable) or (section='friends' and relationship='friends') or (section='requests' and relationship in ('incoming','outgoing')))
      and (term='' or strpos(lower(concat_ws(' ',name,username,country,school,interests,languages)),ltrim(term,'@'))>0)
  ), items as (
    select id,name,username,country,school,bio,interests,languages,allow_requests,can_message,relationship
    from filtered order by case when relationship='incoming' then 0 else 1 end,lower(name),id limit 24 offset page_number::bigint*24
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by case when relationship='incoming' then 0 else 1 end,lower(name),id) from items i),'[]'::jsonb),
      'total',(select count(*) from filtered),'incoming_count',(select count(*) from visible where relationship='incoming'),
      'friends_count',(select count(*) from visible where relationship='friends'),
      'own',coalesce((select to_jsonb(d)-'user_id' from public.member_details d where user_id=actor),
        jsonb_build_object('bio','','interests','','languages','','discoverable',true,'allow_requests',true))) into result;
  return result;
end;
$$;

create function interoom_private.social_friend_action(peer_id uuid,action text) returns text
language plpgsql security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); friendship public.friendships; next_status text;
begin
  if peer_id is null or peer_id=actor or action is null or action not in ('request','accept','decline','cancel','remove') then
    raise exception 'Choose a valid action.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('social-rate:'||actor::text,0));
  -- Same pair lock as blocking and messaging: a block cannot race a new request.
  perform pg_advisory_xact_lock(hashtextextended('dm-pair:'||least(actor,peer_id)::text||greatest(actor,peer_id)::text,0));
  if interoom_private.dm_blocked(peer_id) or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=peer_id and u.email_confirmed_at is not null and u.deleted_at is null and not coalesce(u.is_anonymous,false)) then
    raise exception 'This member is unavailable.' using errcode='42501'; end if;
  select * into friendship from public.friendships where user_low=least(actor,peer_id) and user_high=greatest(actor,peer_id) for update;
  if action='request' then
    if friendship.status in ('pending','accepted') then return friendship.status; end if;
    if exists(select 1 from public.member_details where user_id=peer_id and (not discoverable or not allow_requests)) then
      raise exception 'This member is unavailable for friend requests.' using errcode='42501'; end if;
    if friendship.id is not null and friendship.updated_at>clock_timestamp()-interval '7 days' then
      raise exception 'Wait before requesting this member again.' using errcode='P0001'; end if;
    if (select count(*) from interoom_private.friend_request_events where actor_id=actor and created_at>clock_timestamp()-interval '1 hour')>=10
      or (select count(*) from interoom_private.friend_request_events where actor_id=actor and created_at>clock_timestamp()-interval '1 day')>=50 then
      raise exception 'Too many friend requests.' using errcode='P0001'; end if;
    insert into interoom_private.friend_request_events(actor_id) values(actor);
    insert into public.friendships(user_low,user_high,requester_id) values(least(actor,peer_id),greatest(actor,peer_id),actor)
      on conflict(user_low,user_high) do update set requester_id=actor,status='pending',version=public.friendships.version+1,updated_at=clock_timestamp()
      returning * into friendship;
    perform interoom_private.notice_add(actor,peer_id,'friend_request','friend_request:'||friendship.id::text||':'||friendship.version::text);
    return 'pending';
  end if;
  if friendship.id is null then raise exception 'Request unavailable.' using errcode='42501'; end if;
  if (action in ('accept','decline') and friendship.requester_id=actor)
     or (action='cancel' and friendship.requester_id<>actor) then
    raise exception 'This action belongs to the other member.' using errcode='42501'; end if;
  next_status:=case action when 'accept' then 'accepted' when 'decline' then 'declined' when 'cancel' then 'cancelled' else 'removed' end;
  if friendship.status=next_status then return next_status; end if;
  if (action='remove' and friendship.status<>'accepted') or (action<>'remove' and friendship.status<>'pending') then
    raise exception 'This request has changed. Refresh and try again.' using errcode='22023'; end if;
  update public.friendships set status=next_status,version=version+1,updated_at=clock_timestamp() where id=friendship.id returning * into friendship;
  perform interoom_private.social_archive_notices(friendship.id);
  if action='accept' then
    perform interoom_private.notice_add(actor,peer_id,'friend_accepted','friend_accepted:'||friendship.id::text||':'||friendship.version::text);
  end if;
  return next_status;
end;
$$;

create function interoom_private.social_on_block() returns trigger
language plpgsql security definer set search_path='' as $$
declare friendship uuid;
begin
  update public.friendships set status='removed',version=version+1,updated_at=clock_timestamp()
    where user_low=least(new.blocker_id,new.blocked_id) and user_high=greatest(new.blocker_id,new.blocked_id)
      and status in ('pending','accepted') returning id into friendship;
  if friendship is not null then perform interoom_private.social_archive_notices(friendship); end if;
  return new;
end;
$$;
create trigger friend_block_cleanup after insert on public.user_blocks for each row execute function interoom_private.social_on_block();

create function public.social_save_profile(bio text,interests text,languages text,discoverable boolean,allow_requests boolean) returns void
language sql security invoker set search_path='' as $$ select interoom_private.social_save_profile(bio,interests,languages,discoverable,allow_requests); $$;
create function public.social_directory(search_text text default '',section text default 'discover',page_number integer default 0) returns jsonb
language sql stable security invoker set search_path='' as $$ select interoom_private.social_directory(search_text,section,page_number); $$;
create function public.social_friend_action(peer_id uuid,action text) returns text
language sql security invoker set search_path='' as $$ select interoom_private.social_friend_action(peer_id,action); $$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','interoom_private') and p.proname like 'social\_%' escape '\'
  loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    if f.proname in ('social_directory','social_save_profile','social_friend_action') then
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
alter publication supabase_realtime add table public.friendships;
commit;

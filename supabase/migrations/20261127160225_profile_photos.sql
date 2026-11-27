begin;
alter table public.profiles add column avatar_path text;
alter table public.profiles add constraint profile_avatar_owned_path check(avatar_path is null or
  avatar_path ~ ('^'||id::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'));

create index profiles_avatar_path_idx on public.profiles(avatar_path) where avatar_path is not null;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-photos','profile-photos',false,524288,array['image/jpeg']);

create function interoom_private.avatar_can_upload(object_name text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member();
begin
  if object_name is null or object_name !~ ('^'||actor::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('avatar:'||actor::text,0));
  return (select count(*)<4 from storage.objects where bucket_id='profile-photos' and split_part(name,'/',1)=actor::text);
end;
$$;
create function interoom_private.avatar_can_read(object_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select interoom_private.dm_is_member() and (split_part(object_name,'/',1)=auth.uid()::text or
    exists(select 1 from public.profiles p where p.avatar_path=object_name and not interoom_private.dm_blocked(p.id)));
$$;
create function interoom_private.avatar_can_delete(object_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select interoom_private.dm_is_member() and split_part(object_name,'/',1)=auth.uid()::text
    and not exists(select 1 from public.profiles p where p.avatar_path=object_name);
$$;
create policy avatar_upload_own on storage.objects for insert to authenticated
  with check(bucket_id='profile-photos' and interoom_private.avatar_can_upload(name));
create policy avatar_read_members on storage.objects for select to authenticated
  using(bucket_id='profile-photos' and interoom_private.avatar_can_read(name));
create policy avatar_delete_own_unused on storage.objects for delete to authenticated
  using(bucket_id='profile-photos' and interoom_private.avatar_can_delete(name));
-- No UPDATE policy: each image has an immutable UUID path.

create function interoom_private.profile_set_avatar(next_path text,expected_path text default null) returns text
language plpgsql security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); current_path text;
begin
  perform pg_advisory_xact_lock(hashtextextended('avatar:'||actor::text,0));
  select avatar_path into current_path from public.profiles where id=actor for update;
  if current_path is distinct from expected_path then raise exception 'Your photo changed in another session. Refresh and try again.' using errcode='40001'; end if;
  if next_path is not null and (next_path !~ ('^'||actor::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') or
    not exists(select 1 from storage.objects where bucket_id='profile-photos' and name=next_path
      and metadata->>'mimetype'='image/jpeg' and (metadata->>'size')::bigint between 1 and 524288)) then
    raise exception 'Upload a valid profile photo first.' using errcode='22023'; end if;
  update public.profiles set avatar_path=next_path where id=actor;
  return next_path;
end;
$$;
create function public.profile_set_avatar(next_path text,expected_path text default null) returns text
language sql security invoker set search_path='' as $$ select interoom_private.profile_set_avatar(next_path,expected_path); $$;
revoke all on function interoom_private.avatar_can_upload(text),interoom_private.avatar_can_read(text),interoom_private.avatar_can_delete(text),
  interoom_private.profile_set_avatar(text,text),public.profile_set_avatar(text,text) from public,anon,authenticated;
grant execute on function interoom_private.avatar_can_upload(text),interoom_private.avatar_can_read(text),interoom_private.avatar_can_delete(text),
  interoom_private.profile_set_avatar(text,text),public.profile_set_avatar(text,text) to authenticated;

create or replace function interoom_private.social_directory(search_text text default '',section text default 'discover',page_number integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); term text:=lower(trim(search_text)); result jsonb;
begin
  if term is null or char_length(term)>80 or section is null or section not in ('discover','friends','requests')
    or page_number is null or page_number<0 or page_number>100000 then
    raise exception 'Invalid search.' using errcode='22023'; end if;
  with visible as materialized (
    select p.id,p.name,p.avatar_path,p.username,p.country,p.school,coalesce(d.bio,'') as bio,
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
    select id,name,avatar_path,username,country,school,bio,interests,languages,allow_requests,can_message,relationship
    from filtered order by case when relationship='incoming' then 0 else 1 end,lower(name),id limit 24 offset page_number::bigint*24
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by case when relationship='incoming' then 0 else 1 end,lower(name),id) from items i),'[]'::jsonb),
      'total',(select count(*) from filtered),'incoming_count',(select count(*) from visible where relationship='incoming'),
      'friends_count',(select count(*) from visible where relationship='friends'),
      'own',coalesce((select to_jsonb(d)-'user_id' from public.member_details d where user_id=actor),
        jsonb_build_object('bio','','interests','','languages','','discoverable',true,'allow_requests',true)) || jsonb_build_object('avatar_path',(select avatar_path from public.profiles where id=actor))) into result;
  return result;
end;
$$;

create or replace function interoom_private.dm_search_members(search_text text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := interoom_private.dm_require_member(); term text := lower(trim(search_text));
begin
  if term is null or char_length(term)<2 then return '[]'::jsonb; end if;
  if char_length(term)>80 then raise exception 'Search is too long' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(p)) from (
    select p.id,p.name,p.avatar_path,p.username from public.profiles p join auth.users u on u.id=p.id
    left join public.dm_preferences pref on pref.user_id=p.id
    where p.id<>actor and u.email_confirmed_at is not null and u.deleted_at is null
      and not coalesce(u.is_anonymous,false) and coalesce(pref.allow_new_conversations,true)
      and not interoom_private.dm_blocked(p.id)
      and (strpos(lower(p.name),term)>0 or strpos(p.username,ltrim(term,'@'))>0)
    order by p.name,p.id limit 25
  ) p),'[]'::jsonb);
end;
$$;

create or replace function interoom_private.dm_inbox(page_number integer default 0, conversation_filter uuid default null) returns jsonb
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
    select c.id,c.last_activity_at,p.id as peer_id,p.name,p.username,case when not interoom_private.dm_blocked(p.id) then p.avatar_path end as avatar_path,
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

create or replace function interoom_private.notice_inbox(page_number integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=interoom_private.dm_require_member(); result jsonb;
begin
  if page_number is null or page_number<0 or page_number>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
  with mine as materialized (
    select n.* from public.notifications n where recipient_id=actor and not interoom_private.dm_blocked(n.actor_id)
  ), items as (
    select n.id,n.kind,n.post_id,n.reply_id,n.conversation_id,n.updated_at,n.version,n.read_at,n.unavailable,p.name,p.username,p.id as actor_id,p.avatar_path,post.room_id
    from mine n join public.profiles p on p.id=n.actor_id left join public.posts post on post.id=n.post_id
    order by n.updated_at desc,n.id limit 30 offset page_number::bigint*30
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by i.updated_at desc,i.id) from items i),'[]'::jsonb),
    'unread_count',(select count(*) from mine where read_at is null and not unavailable),'total',(select count(*) from mine),
    'snapshot_at',statement_timestamp()) into result;
  return result;
end;
$$;
commit;

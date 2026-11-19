begin;
alter table public.profiles add column school text not null default '' check (char_length(school) <= 120);
grant insert (school), update (school) on public.profiles to authenticated;

create table public.ambassadors (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  school text not null check (char_length(trim(school)) between 2 and 120),
  assigned_at timestamptz not null default now()
);
alter table public.ambassadors enable row level security;
revoke all on public.ambassadors from public, anon, authenticated;
grant select on public.ambassadors to authenticated;
create policy "Members can view school ambassadors" on public.ambassadors for select to authenticated using (true);

create schema interoom_private;
revoke all on schema interoom_private from public, anon, authenticated;
create table interoom_private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table interoom_private.ambassador_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  member_id uuid,
  action text not null check (action in ('assign', 'remove')),
  school text,
  created_at timestamptz not null default now()
);
alter table interoom_private.admins enable row level security;
alter table interoom_private.ambassador_events enable row level security;
revoke all on all tables in schema interoom_private from public, anon, authenticated;

create function public.is_community_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from interoom_private.admins where user_id = (select auth.uid()));
$$;

create function public.find_community_members(search_text text)
returns table(user_id uuid, name text, school text, email text, ambassador_school text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_community_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if search_text is null or char_length(trim(search_text)) < 2 then return; end if;
  if char_length(search_text) > 120 then raise exception 'Search is too long' using errcode='22023'; end if;
  return query select p.id, p.name, p.school, u.email::text, a.school
    from public.profiles p join auth.users u on u.id=p.id left join public.ambassadors a on a.user_id=p.id
    where strpos(lower(p.name), lower(trim(search_text))) > 0
       or strpos(lower(p.school), lower(trim(search_text))) > 0
       or strpos(lower(u.email), lower(trim(search_text))) > 0
    order by p.name, p.id limit 25;
end;
$$;

create function public.set_school_ambassador(member_id uuid, school_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare old_school text;
begin
  if not public.is_community_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if member_id is null then raise exception 'Choose a member' using errcode='22023'; end if;
  if school_name is null then
    delete from public.ambassadors where user_id=member_id returning school into old_school;
    if found then
      insert into interoom_private.ambassador_events(actor_id,member_id,action,school) values(auth.uid(),member_id,'remove',old_school);
    end if;
  else
    if char_length(trim(school_name)) not between 2 and 120 then raise exception 'School must be 2–120 characters' using errcode='22023'; end if;
    insert into public.ambassadors(user_id,school) values(member_id,trim(school_name))
      on conflict(user_id) do update set school=excluded.school,assigned_at=now();
    insert into interoom_private.ambassador_events(actor_id,member_id,action,school) values(auth.uid(),member_id,'assign',trim(school_name));
  end if;
end;
$$;
revoke all on function public.is_community_admin(), public.find_community_members(text), public.set_school_ambassador(uuid,text) from public, anon, authenticated;
grant execute on function public.is_community_admin(), public.find_community_members(text), public.set_school_ambassador(uuid,text) to authenticated;
commit;

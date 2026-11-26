begin;

-- Auth is the source of registered accounts, including unfinished profiles.
-- No direct access to auth.users or the private admin table is granted.
create function public.list_community_members(search_text text default '', page_number integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  term text := lower(trim(coalesce(search_text, '')));
  member_count bigint;
  selected_page integer;
  members jsonb;
begin
  if not public.is_community_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if char_length(coalesce(search_text, '')) > 120 then
    raise exception 'Search is too long' using errcode = '22023';
  end if;
  if page_number is null or page_number < 0 then
    raise exception 'Page must be zero or greater' using errcode = '22023';
  end if;

  with matched as materialized (
    select u.id as user_id, u.email::text as email, u.created_at,
      (u.email_confirmed_at is not null) as email_verified,
      (p.id is not null) as has_profile, p.name, p.country, p.school,
      a.school as ambassador_school,
      exists(select 1 from interoom_private.admins ad where ad.user_id = u.id) as is_admin
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.ambassadors a on a.user_id = u.id
    where u.deleted_at is null and not coalesce(u.is_anonymous, false)
      and (term = '' or strpos(lower(coalesce(u.email, '')), term) > 0
        or strpos(lower(coalesce(p.name, '')), term) > 0
        or strpos(lower(coalesce(p.school, '')), term) > 0)
  ), totals as (
    select count(*) as total from matched
  ), requested_page as (
    select total, least(page_number::bigint, greatest((total - 1) / 25, 0))::integer as page from totals
  ), page_rows as (
    select * from matched order by created_at desc nulls last, user_id
    limit 25 offset (select page::bigint * 25 from requested_page)
  )
  select r.total, r.page,
    coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc nulls last, p.user_id) from page_rows p), '[]'::jsonb)
  into member_count, selected_page, members from requested_page r;

  return jsonb_build_object('items', members, 'total', member_count, 'page', selected_page, 'page_size', 25);
end;
$$;

revoke all on function public.list_community_members(text, integer) from public, anon, authenticated;
grant execute on function public.list_community_members(text, integer) to authenticated;
comment on function public.list_community_members(text, integer) is
  'Admin-only paginated registered-user directory; excludes anonymous and deleted accounts, includes accounts without profiles.';

commit;

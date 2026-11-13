begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  country text not null default '' check (char_length(country) <= 60)
);

create table public.rooms (
  id text primary key,
  name text not null,
  description text not null,
  position integer not null unique
);

insert into public.rooms (id, name, description, position) values
  ('general', 'General', 'Introductions, questions, and everything else.', 1),
  ('study-lounge', 'Study Lounge', 'Coursework, exams, and finding a study partner.', 2),
  ('university-careers', 'University & Careers', 'Applications, university choices, and what comes next.', 3),
  ('life-abroad', 'Life Abroad', 'Moving countries and settling into a new school.', 4),
  ('culture-exchange', 'Culture Exchange', 'Languages, traditions, and things you miss from home.', 5);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id),
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table public.replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table public.reactions (
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  primary key (post_id, author_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id),
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  target_kind text not null check (target_kind in ('post', 'reply', 'message')),
  target_id uuid not null,
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (reporter_id, target_kind, target_id)
);

create index posts_created_at_idx on public.posts (created_at desc);
create index posts_room_created_at_idx on public.posts (room_id, created_at desc);
create index replies_post_created_at_idx on public.replies (post_id, created_at);
create index messages_room_created_at_idx on public.messages (room_id, created_at desc);
create index posts_author_idx on public.posts (author_id);
create index replies_author_idx on public.replies (author_id);
create index reactions_author_idx on public.reactions (author_id);
create index messages_author_idx on public.messages (author_id);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.posts enable row level security;
alter table public.replies enable row level security;
alter table public.reactions enable row level security;
alter table public.messages enable row level security;
alter table public.reports enable row level security;

revoke all on public.profiles, public.rooms, public.posts, public.replies,
  public.reactions, public.messages, public.reports from public, anon, authenticated;

grant select on public.rooms to anon, authenticated;
grant select on public.profiles, public.posts, public.replies, public.reactions, public.messages to authenticated;
grant insert (id, name, country), update (name, country) on public.profiles to authenticated;
grant insert (room_id, body), delete on public.posts to authenticated;
grant insert (post_id, body), delete on public.replies to authenticated;
grant insert (post_id), delete on public.reactions to authenticated;
grant insert (room_id, body), delete on public.messages to authenticated;
grant insert (target_kind, target_id, reason) on public.reports to authenticated;

create policy "Anyone can browse rooms" on public.rooms for select using (true);
create policy "Members can read display profiles" on public.profiles for select to authenticated using (true);
create policy "Members create their own profile" on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "Members edit their own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Members can read posts" on public.posts for select to authenticated using (true);
create policy "Members create their own posts" on public.posts for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "Authors delete their own posts" on public.posts for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "Members can read replies" on public.replies for select to authenticated using (true);
create policy "Members create their own replies" on public.replies for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "Authors delete their own replies" on public.replies for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "Members can read reactions" on public.reactions for select to authenticated using (true);
create policy "Members add their own reactions" on public.reactions for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "Members remove their own reactions" on public.reactions for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "Members can read room chat" on public.messages for select to authenticated using (true);
create policy "Members send their own messages" on public.messages for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "Authors delete their own messages" on public.messages for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "Members can report existing content" on public.reports for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and case target_kind
      when 'post' then exists (select 1 from public.posts where id = target_id)
      when 'reply' then exists (select 1 from public.replies where id = target_id)
      when 'message' then exists (select 1 from public.messages where id = target_id)
      else false
    end
  );

alter publication supabase_realtime add table public.messages;

commit;

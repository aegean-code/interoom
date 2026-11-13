begin;
select set_config('test.alice', gen_random_uuid()::text, true);
select set_config('test.bob', gen_random_uuid()::text, true);
insert into auth.users (id) values (current_setting('test.alice')::uuid), (current_setting('test.bob')::uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.alice'), true);
insert into public.profiles (id,name) values (auth.uid(),'Permission test A');
insert into public.posts (room_id,body) values ('general','Permission test post');
insert into public.messages (room_id,body) values ('general','Permission test message');
select set_config('test.post', (select id::text from public.posts where author_id=auth.uid()), true);
select set_config('request.jwt.claim.sub', current_setting('test.bob'), true);
insert into public.profiles (id,name) values (auth.uid(),'Permission test B');
insert into public.replies (post_id,body) values (current_setting('test.post')::uuid,'Permission test reply');
insert into public.reactions (post_id) values (current_setting('test.post')::uuid);
insert into public.reports(target_kind,target_id,reason) values ('post',current_setting('test.post')::uuid,'Permission test');
do $$
declare affected integer;
begin
 delete from public.posts where id=current_setting('test.post')::uuid;
 get diagnostics affected = row_count;
 if affected <> 0 then raise exception 'Other member deleted a post'; end if;
 update public.profiles set name='Changed' where id=current_setting('test.alice')::uuid;
 get diagnostics affected = row_count;
 if affected <> 0 then raise exception 'Other member changed profile'; end if;
 begin
  insert into public.profiles(id,name) values(gen_random_uuid(),'Invalid');
  raise exception 'Profile impersonation succeeded';
 exception when insufficient_privilege then null; end;
 begin
  perform * from public.reports;
  raise exception 'Private reports exposed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', current_setting('test.alice'), true);
delete from public.posts where id=current_setting('test.post')::uuid;
reset role;
do $$ begin
 if exists(select 1 from public.replies where post_id=current_setting('test.post')::uuid) then raise exception 'Reply cascade failed'; end if;
 if exists(select 1 from public.reactions where post_id=current_setting('test.post')::uuid) then raise exception 'Reaction cascade failed'; end if;
end $$;
set local role anon;
do $$ begin
 perform * from public.rooms;
 begin
  perform * from public.messages;
  raise exception 'Anonymous chat read succeeded';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'All ownership, report privacy, cascade, and anonymous-access checks passed' as result;
rollback;

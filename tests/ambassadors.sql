-- Temporary fixtures remain inside this transaction and are always rolled back.
begin;
select set_config('test.admin', gen_random_uuid()::text,true);
select set_config('test.member', gen_random_uuid()::text,true);
insert into auth.users(id,email) values(current_setting('test.admin')::uuid,current_setting('test.admin')||'@example.invalid'),(current_setting('test.member')::uuid,current_setting('test.member')||'@example.invalid');
insert into public.profiles(id,name,school) values(current_setting('test.admin')::uuid,'QA admin','QA school'),(current_setting('test.member')::uuid,'QA member','QA school');
insert into interoom_private.admins(user_id) values(current_setting('test.admin')::uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.member'),true);
do $$ begin
 if public.is_community_admin() then raise exception 'Member has admin access'; end if;
 begin perform public.set_school_ambassador(auth.uid(),'Fake school'); raise exception 'Member assigned a role'; exception when insufficient_privilege then null; end;
 begin perform * from public.find_community_members('QA'); raise exception 'Member searched private emails'; exception when insufficient_privilege then null; end;
 begin insert into public.ambassadors(user_id,school) values(auth.uid(),'Fake school'); raise exception 'Direct ambassador insert permitted'; exception when insufficient_privilege then null; end;
 begin insert into interoom_private.admins(user_id) values(auth.uid()); raise exception 'Member promoted themselves'; exception when insufficient_privilege then null; end;
 update public.profiles set school='My updated school' where id=auth.uid();
 if public.is_community_admin() then raise exception 'Profile edit changed admin role'; end if;
end $$;
select set_config('request.jwt.claim.sub',current_setting('test.admin'),true);
do $$ begin
 if not public.is_community_admin() then raise exception 'Admin not recognized'; end if;
 if not exists(select 1 from public.find_community_members('QA member') where user_id=current_setting('test.member')::uuid) then raise exception 'Admin search failed'; end if;
 begin perform public.set_school_ambassador(current_setting('test.member')::uuid,' '); raise exception 'Empty school accepted'; exception when invalid_parameter_value then null; end;
end $$;
select public.set_school_ambassador(current_setting('test.member')::uuid,'  QA International School  ');
select set_config('request.jwt.claim.sub',current_setting('test.member'),true);
do $$ begin
 if not exists(select 1 from public.ambassadors where user_id=auth.uid() and school='QA International School') then raise exception 'Ambassador badge not readable'; end if;
 begin perform public.set_school_ambassador(auth.uid(),null); raise exception 'Ambassador can manage roles'; exception when insufficient_privilege then null; end;
 begin update public.ambassadors set school='Unapproved school' where user_id=auth.uid(); raise exception 'Ambassador can change assigned school'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub',current_setting('test.admin'),true);
select public.set_school_ambassador(current_setting('test.member')::uuid,'Updated QA School');
select public.set_school_ambassador(current_setting('test.member')::uuid,null);
do $$ begin
 if exists(select 1 from public.ambassadors where user_id=current_setting('test.member')::uuid) then raise exception 'Removal failed'; end if;
end $$;
reset role;
delete from interoom_private.admins where user_id=current_setting('test.admin')::uuid;
set local role authenticated;
do $$ begin
 if public.is_community_admin() then raise exception 'Admin revocation was not immediate'; end if;
 begin perform public.set_school_ambassador(current_setting('test.member')::uuid,'QA school'); raise exception 'Revoked admin can assign roles'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform * from public.ambassadors; raise exception 'Anonymous directory access'; exception when insufficient_privilege then null; end;
 begin perform public.set_school_ambassador(current_setting('test.member')::uuid,'QA school'); raise exception 'Anonymous RPC access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if (select count(*) from interoom_private.ambassador_events where member_id=current_setting('test.member')::uuid) <> 3 then raise exception 'Role audit missing'; end if;
end $$;
select 'PASS: assignment, updates, removal, school validation, member access, private search, self-promotion denial, immediate revocation, anonymous denial, and audit trail' as result;
rollback;

-- Two-user RLS test for 0001_core.sql.
--
-- Requires a running Postgres with the migration applied and the stub
-- `auth` schema/roles this repo doesn't ship (Supabase itself provides
-- them; see the dev note at the bottom of this file for how it was run
-- here without Docker). This is a real, executable SQL test - run it with
-- `psql -v ON_ERROR_STOP=1 -f this_file.sql` against such a database and a
-- RAISE EXCEPTION means a real failure, not a style complaint.
--
-- It asserts, as two distinct application users:
--   1. each user can see only their own plan/bills/extension_requests
--   2. each user cannot see or modify the other user's rows, even by id
--   3. reminders are readable (via the owning bill) but not writable by
--      ordinary users - only service_role writes them
--   4. audit_log is fully inaccessible to ordinary users in both directions

begin;

-- Two users, created the way Supabase Auth would (insert into auth.users
-- fires the handle_new_auth_user trigger, which creates public.users).
insert into auth.users (id, phone) values
  ('11111111-1111-1111-1111-111111111111', '+2348000000001'),
  ('22222222-2222-2222-2222-222222222222', '+2348000000002');

do $$
begin
  if (select count(*) from public.users) <> 2 then
    raise exception 'expected the auth.users trigger to create 2 public.users rows, got %',
      (select count(*) from public.users);
  end if;
end $$;

-- --- User A creates a plan and a bill ---------------------------------
set role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

insert into public.plans (user_id, cash_on_hand_kobo, income_amount_kobo)
values ('11111111-1111-1111-1111-111111111111', 100000, 500000);

insert into public.bills (id, user_id, name, amount_kobo, due_day)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Rent', 2000000, 5);

insert into public.extension_requests (bill_id, message_text)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Please may I pay the rest in a few days?');

reset role;

-- --- User B creates their own plan and bill ----------------------------
set role authenticated;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

insert into public.plans (user_id, cash_on_hand_kobo, income_amount_kobo)
values ('22222222-2222-2222-2222-222222222222', 500000, 300000);

insert into public.bills (id, user_id, name, amount_kobo, due_day)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Data', 100000, 15);

reset role;

-- --- Assertions, run as each user --------------------------------------
set role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare
  n int;
begin
  select count(*) into n from public.plans;
  if n <> 1 then raise exception 'user A should see exactly 1 plan (their own), saw %', n; end if;

  select count(*) into n from public.bills;
  if n <> 1 then raise exception 'user A should see exactly 1 bill (their own), saw %', n; end if;

  select count(*) into n from public.bills where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if n <> 0 then raise exception 'user A should not be able to select user B''s bill by id'; end if;

  select count(*) into n from public.extension_requests;
  if n <> 1 then raise exception 'user A should see their own extension_request, saw %', n; end if;
end $$;

-- User A tries to update user B's bill directly by id - the UPDATE should
-- affect zero rows (RLS filters the target, not an error), not succeed.
update public.bills set amount_kobo = 1 where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
do $$
begin
  if (select amount_kobo from public.bills where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') = 1 then
    raise exception 'user A must not be able to modify user B''s bill';
  end if;
end $$;
reset role;

-- --- users: a user may update locale/notify_channel but not kyc_status ---
set role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

update public.users set notify_channel = 'whatsapp' where id = '11111111-1111-1111-1111-111111111111';
do $$
begin
  if (select notify_channel from public.users where id = '11111111-1111-1111-1111-111111111111') <> 'whatsapp' then
    raise exception 'a user should be able to update their own notify_channel';
  end if;
end $$;

do $$
begin
  begin
    update public.users set kyc_status = 'verified' where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'a user must not be able to self-verify kyc_status through the Data API';
  exception
    when insufficient_privilege then
      null; -- expected: column-level grant denies this
  end;
end $$;
reset role;

-- --- reminders: readable via bill ownership, not writable by users -----
set role service_role;
insert into public.reminders (bill_id, send_at, channel)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() + interval '3 days', 'sms');
reset role;

set role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  n int;
begin
  select count(*) into n from public.reminders;
  if n <> 1 then raise exception 'user A should see the reminder on their own bill, saw %', n; end if;
end $$;

-- An ordinary user has no INSERT policy on reminders at all - this must fail.
do $$
begin
  begin
    insert into public.reminders (bill_id, send_at, channel)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now(), 'sms');
    raise exception 'ordinary users must not be able to insert reminders directly';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end $$;

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare
  n int;
begin
  select count(*) into n from public.reminders;
  if n <> 0 then raise exception 'user B must not see user A''s reminder, saw %', n; end if;
end $$;
reset role;

-- --- audit_log: no client access in either direction --------------------
set role service_role;
insert into public.audit_log (actor, action, entity) values
  ('11111111-1111-1111-1111-111111111111', 'bill.created', 'bills');
reset role;

set role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  n int;
begin
  select count(*) into n from public.audit_log;
  if n <> 0 then raise exception 'ordinary users must see zero audit_log rows (RLS has no select policy), saw %', n; end if;

  begin
    insert into public.audit_log (actor, action, entity) values (auth.uid(), 'x', 'y');
    raise exception 'ordinary users must not be able to insert into audit_log';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end $$;
reset role;

rollback; -- leave no trace; this file only asserts, it doesn't seed data

\echo 'ALL RLS ASSERTIONS PASSED'

-- Dev note: run without Docker by standing up a throwaway native Postgres
-- 15 cluster (no Supabase CLI / Docker involved) and a minimal stand-in for
-- what Supabase normally provides (an `auth.users` table, an `auth.uid()`
-- function reading `request.jwt.claim.sub`, and the anon/authenticated/
-- service_role roles with the same default grants PostgREST sets up) before
-- applying 0001_core.sql and this file. That stub schema is NOT part of
-- this repo (Supabase provides the real one) - it lived only in /tmp for
-- this test run. This exercises the actual SQL and RLS policies for real,
-- but it is not a substitute for running `supabase start` (needs Docker,
-- not available on this machine) against the real Supabase stack before
-- trusting this in production.

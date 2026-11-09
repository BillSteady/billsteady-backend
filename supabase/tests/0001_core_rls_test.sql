-- RLS test for the parts of 0001_core.sql that are still true after
-- 0004_pivot.sql: the `users` table and `audit_log`.
--
-- This file originally also tested plans/bills/extension_requests/
-- reminders - all dropped or renamed by 0004_pivot.sql (the pivot to
-- non-custodial Stellar bill pay). Updating a TEST to match the schema
-- it's actually run against is normal and expected (unlike a migration,
-- which is append-only); saved_billers/biller_settlements/payment_orders
-- are covered in 0004_pivot_test.sql instead, which runs after the rename.
--
-- Run with `psql -v ON_ERROR_STOP=1 -f this_file.sql` against a database
-- with the stub auth schema + all four migrations applied in order - see
-- _stub_auth_schema.sql's header for the exact sequence. A RAISE EXCEPTION
-- means a real failure, not a style complaint.
--
-- As of 0004, `public.users.id` is no longer a foreign key to auth.users
-- (see that migration's "users auth model" section) - rows are created
-- directly here instead of via the old signup trigger, which 0004 drops.

begin;

insert into public.users (id, stellar_address) values
  ('11111111-1111-1111-1111-111111111111', 'GUSER0000000000000000000000000000000000000000000000000A'),
  ('22222222-2222-2222-2222-222222222222', 'GUSER0000000000000000000000000000000000000000000000000B');

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

-- A user can see only their own row, not another user's.
do $$
declare
  n int;
begin
  select count(*) into n from public.users;
  if n <> 1 then raise exception 'user A should see exactly 1 users row (their own), saw %', n; end if;
end $$;
reset role;

-- --- audit_log: no client access in either direction --------------------
set role service_role;
insert into public.audit_log (actor, action, entity) values
  ('11111111-1111-1111-1111-111111111111', 'payment_order.created', 'payment_orders');
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

\echo '0001 RLS ASSERTIONS PASSED'

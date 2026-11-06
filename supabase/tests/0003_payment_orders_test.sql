-- RLS + constraint test for 0003_payment_orders.sql.
--
-- Same harness as 0001_core_rls_test.sql: requires a Postgres with
-- 0001/0002/0003 applied plus the stub `auth` schema/roles Supabase itself
-- provides in production (see the dev note at the bottom of
-- 0001_core_rls_test.sql for exactly how this was run without Docker).
-- Run with `psql -v ON_ERROR_STOP=1 -f this_file.sql`; a RAISE EXCEPTION
-- means a real failure.
--
-- It asserts:
--   1. a user can read only their own payment_orders, not another user's,
--      even by id
--   2. an ordinary user cannot INSERT a payment_order directly (only
--      service_role, i.e. the not-yet-built Edge Function, can)
--   3. an ordinary user cannot UPDATE a payment_order's status directly
--      (e.g. can't self-mark an order 'paid')
--   4. idempotency_key is actually enforced unique at the database level -
--      a second insert with the same key fails, it doesn't silently
--      create a duplicate order
--   5. updated_at is bumped automatically on UPDATE (the reconciliation
--      job, tracked separately, depends on this being real)

begin;

insert into auth.users (id, phone) values
  ('33333333-3333-3333-3333-333333333333', '+2348000000003'),
  ('44444444-4444-4444-4444-444444444444', '+2348000000004');

set role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
insert into public.bills (id, user_id, name, amount_kobo, due_day)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'Electricity', 500000, 10);
reset role;

set role authenticated;
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
insert into public.bills (id, user_id, name, amount_kobo, due_day)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'Airtime', 100000, 20);
reset role;

-- --- Only service_role (the future Edge Function) creates orders --------
set role service_role;
insert into public.payment_orders (user_id, bill_id, amount_kobo, provider, idempotency_key)
values (
  '33333333-3333-3333-3333-333333333333',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  500000,
  'vtpass',
  'order-A-001'
);
insert into public.payment_orders (user_id, bill_id, amount_kobo, provider, idempotency_key)
values (
  '44444444-4444-4444-4444-444444444444',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  100000,
  'vtpass',
  'order-B-001'
);
reset role;

-- --- 1. read isolation ---------------------------------------------------
set role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
declare
  n int;
begin
  select count(*) into n from public.payment_orders;
  if n <> 1 then raise exception 'user A should see exactly 1 payment_order (their own), saw %', n; end if;

  select count(*) into n from public.payment_orders where idempotency_key = 'order-B-001';
  if n <> 0 then raise exception 'user A should not be able to select user B''s order by idempotency_key'; end if;
end $$;

-- --- 2. no client-side insert --------------------------------------------
do $$
begin
  begin
    insert into public.payment_orders (user_id, bill_id, amount_kobo, provider, idempotency_key)
    values ('33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1, 'vtpass', 'forged-order');
    raise exception 'ordinary users must not be able to insert payment_orders directly';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end $$;

-- --- 3. no client-side status update -------------------------------------
-- Unlike INSERT (which raises a row-level-security violation exception for
-- a disallowed row), UPDATE with zero applicable policy doesn't raise -
-- Postgres just filters the USING predicate to "no rows match", so the
-- UPDATE silently affects 0 rows (same behavior 0001_core_rls_test.sql
-- already demonstrates for a cross-user `bills` update). Assert on the
-- actual row being unchanged, not on an exception that was never going to
-- be raised - an earlier version of this test wrongly expected one and
-- would have passed even if the UPDATE had silently succeeded, which
-- defeats the point of the assertion.
update public.payment_orders set status = 'paid' where idempotency_key = 'order-A-001';
do $$
begin
  if (select status from public.payment_orders where idempotency_key = 'order-A-001') = 'paid' then
    raise exception 'ordinary users must not be able to self-mark their own order as paid';
  end if;
end $$;
reset role;

-- --- 4. idempotency_key is enforced unique at the DB level --------------
set role service_role;
do $$
begin
  begin
    insert into public.payment_orders (user_id, bill_id, amount_kobo, provider, idempotency_key)
    values (
      '33333333-3333-3333-3333-333333333333',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      999,
      'vtpass',
      'order-A-001' -- same key as the first insert above
    );
    raise exception 'a duplicate idempotency_key must be rejected by a UNIQUE constraint, not silently inserted';
  exception
    when unique_violation then
      null; -- expected
  end;
end $$;

do $$
declare
  n int;
begin
  select count(*) into n from public.payment_orders where idempotency_key = 'order-A-001';
  if n <> 1 then raise exception 'expected exactly 1 row with idempotency_key order-A-001 after the rejected duplicate, saw %', n; end if;
end $$;

-- --- 5. updated_at is bumped automatically on UPDATE ---------------------
do $$
declare
  before_ts timestamptz;
  after_ts timestamptz;
begin
  select updated_at into before_ts from public.payment_orders where idempotency_key = 'order-A-001';
  perform pg_sleep(0.01);
  update public.payment_orders set status = 'funded' where idempotency_key = 'order-A-001';
  select updated_at into after_ts from public.payment_orders where idempotency_key = 'order-A-001';
  if after_ts <= before_ts then
    raise exception 'updated_at should advance on UPDATE (before=%, after=%)', before_ts, after_ts;
  end if;
end $$;
reset role;

rollback; -- leave no trace; this file only asserts, it doesn't seed data

\echo 'ALL PAYMENT_ORDERS ASSERTIONS PASSED'

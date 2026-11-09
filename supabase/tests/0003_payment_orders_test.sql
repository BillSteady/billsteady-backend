-- RLS + constraint test for payment_orders, updated for the schema as it
-- exists after 0004_pivot.sql (saved_billers instead of bills, biller_id
-- instead of bill_id, and the new stellar_address/asset_code/order_ref
-- columns are NOT NULL). Run after 0001-0004 are all applied, same stub
-- auth harness as the other test files - see _stub_auth_schema.sql.
--
-- It asserts:
--   1. a user can read only their own payment_orders, not another user's,
--      even by id
--   2. an ordinary user cannot INSERT a payment_order directly (only
--      service_role can)
--   3. an ordinary user cannot UPDATE a payment_order's status directly
--      (e.g. can't self-mark an order 'paid')
--   4. idempotency_key is enforced unique at the database level
--   5. order_ref is enforced unique and exactly 32 bytes at the database
--      level - this is the value the on-chain BillPaymentRouter.pay() call
--      must match byte-for-byte, so both constraints matter for real
--   6. updated_at is bumped automatically on UPDATE

begin;

insert into public.users (id, stellar_address) values
  ('33333333-3333-3333-3333-333333333333', 'GUSER0000000000000000000000000000000000000000000000000C'),
  ('44444444-4444-4444-4444-444444444444', 'GUSER0000000000000000000000000000000000000000000000000D');

set role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
insert into public.saved_billers (id, user_id, name)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'Ikeja Electric');
reset role;

set role authenticated;
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
insert into public.saved_billers (id, user_id, name)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'MTN Airtime');
reset role;

-- --- Only service_role (sep10-auth's downstream payment function) creates orders ---
-- order_ref uses repeat('aa', 32) rather than a hand-counted hex literal,
-- specifically to avoid an off-by-one in the fixture itself (32 bytes =
-- exactly BytesN<32> on-chain - see 0004_pivot.sql's column comment).
set role service_role;
insert into public.payment_orders (user_id, biller_id, amount_kobo, provider, idempotency_key, stellar_address, asset_code, order_ref)
values (
  '33333333-3333-3333-3333-333333333333',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  1850000,
  'vtpass',
  'order-A-001',
  'GUSER0000000000000000000000000000000000000000000000000C',
  'USDC',
  decode(repeat('aa', 32), 'hex')
);
insert into public.payment_orders (user_id, biller_id, amount_kobo, provider, idempotency_key, stellar_address, asset_code, order_ref)
values (
  '44444444-4444-4444-4444-444444444444',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  500000,
  'vtpass',
  'order-B-001',
  'GUSER0000000000000000000000000000000000000000000000000D',
  'XLM',
  decode(repeat('bb', 32), 'hex')
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
    insert into public.payment_orders (user_id, biller_id, amount_kobo, provider, idempotency_key, stellar_address, asset_code, order_ref)
    values (
      '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1, 'vtpass',
      'forged-order', 'GUSER0000000000000000000000000000000000000000000000000C', 'USDC', decode(repeat('cc', 32), 'hex')
    );
    raise exception 'ordinary users must not be able to insert payment_orders directly';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end $$;

-- --- 3. no client-side status update -------------------------------------
-- UPDATE with zero applicable policy filters to "no rows match" rather than
-- raising - assert on the row's actual state, not an exception that was
-- never going to be raised (see 0001_core_rls_test.sql for the same point).
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
    insert into public.payment_orders (user_id, biller_id, amount_kobo, provider, idempotency_key, stellar_address, asset_code, order_ref)
    values (
      '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 999, 'vtpass',
      'order-A-001', -- same key as the first insert above
      'GUSER0000000000000000000000000000000000000000000000000C', 'USDC', decode(repeat('dd', 32), 'hex')
    );
    raise exception 'a duplicate idempotency_key must be rejected by a UNIQUE constraint, not silently inserted';
  exception
    when unique_violation then
      null; -- expected
  end;
end $$;

-- --- 5a. order_ref is enforced unique -------------------------------------
do $$
begin
  begin
    insert into public.payment_orders (user_id, biller_id, amount_kobo, provider, idempotency_key, stellar_address, asset_code, order_ref)
    values (
      '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 999, 'vtpass',
      'order-A-002',
      'GUSER0000000000000000000000000000000000000000000000000C', 'USDC',
      decode(repeat('aa', 32), 'hex') -- same order_ref as order-A-001
    );
    raise exception 'a duplicate order_ref must be rejected by a UNIQUE constraint - two orders could otherwise claim the same on-chain payment';
  exception
    when unique_violation then
      null; -- expected
  end;
end $$;

-- --- 5b. order_ref must be exactly 32 bytes -------------------------------
do $$
begin
  begin
    insert into public.payment_orders (user_id, biller_id, amount_kobo, provider, idempotency_key, stellar_address, asset_code, order_ref)
    values (
      '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 999, 'vtpass',
      'order-A-003',
      'GUSER0000000000000000000000000000000000000000000000000C', 'USDC',
      decode(repeat('ee', 16), 'hex') -- 16 bytes, not 32 - must match BytesN<32> on-chain
    );
    raise exception 'order_ref must be rejected when it is not exactly 32 bytes';
  exception
    when check_violation then
      null; -- expected
  end;
end $$;

-- --- 6. updated_at is bumped automatically on UPDATE ---------------------
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

\echo '0003/0004 PAYMENT_ORDERS ASSERTIONS PASSED'

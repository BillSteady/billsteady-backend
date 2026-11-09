-- Test for what 0004_pivot.sql itself changes: the dropped tables are
-- really gone, saved_billers no longer carries planning columns, and
-- biller_settlements is public-read/service-role-write-only.
--
-- Run after 0001-0004 are all applied, same stub auth harness as the other
-- test files - see _stub_auth_schema.sql.

begin;

-- --- the old planning tables are really gone, not just renamed ----------
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'plans') then
    raise exception 'plans should have been dropped by 0004_pivot.sql';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'reminders') then
    raise exception 'reminders should have been dropped by 0004_pivot.sql';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'extension_requests') then
    raise exception 'extension_requests should have been dropped by 0004_pivot.sql';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'bills') then
    raise exception 'bills should have been renamed to saved_billers by 0004_pivot.sql, not left behind';
  end if;
end $$;

-- --- saved_billers no longer carries planning columns --------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'saved_billers'
      and column_name in ('amount_kobo', 'due_day', 'recurrence', 'due_date', 'paid_kobo')
  ) then
    raise exception 'saved_billers should have had every planning column dropped by 0004_pivot.sql';
  end if;
end $$;

-- --- users.stellar_address identity works without any auth.users row ----
-- (confirms the new auth model doesn't secretly still depend on the old
-- auth.users-driven signup trigger, which 0004 drops)
insert into public.users (id, stellar_address) values
  ('55555555-5555-5555-5555-555555555555', 'GUSER0000000000000000000000000000000000000000000000000E');

set role authenticated;
set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
do $$
declare
  n int;
begin
  select count(*) into n from public.users where id = auth.uid();
  if n <> 1 then raise exception 'auth.uid() should resolve to the row whose id matches the JWT sub claim, independent of auth.users'; end if;
end $$;
reset role;

-- --- biller_settlements: public read, no client write --------------------
set role service_role;
insert into public.biller_settlements (biller_code, asset_code, settlement_address)
values ('ikeja-electric', 'USDC', 'GSETTLEMENT00000000000000000000000000000000000000000000');
reset role;

set role authenticated;
set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
do $$
declare
  n int;
begin
  select count(*) into n from public.biller_settlements;
  if n <> 1 then raise exception 'biller_settlements should be readable by any authenticated user, saw %', n; end if;

  begin
    insert into public.biller_settlements (biller_code, asset_code, settlement_address)
    values ('fake-biller', 'USDC', 'GATTACKER000000000000000000000000000000000000000000000');
    raise exception 'ordinary users must not be able to write biller_settlements - this is how a payment could get silently redirected';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end $$;
reset role;

-- --- biller_settlements: (biller_code, asset_code) uniqueness ------------
set role service_role;
do $$
begin
  begin
    insert into public.biller_settlements (biller_code, asset_code, settlement_address)
    values ('ikeja-electric', 'USDC', 'GDIFFERENTADDRESS000000000000000000000000000000000000');
    raise exception 'a second settlement address for the same (biller_code, asset_code) must be rejected, not silently accepted - that would be ambiguous about where funds go';
  exception
    when unique_violation then
      null; -- expected
  end;
end $$;
reset role;

rollback; -- leave no trace; this file only asserts, it doesn't seed data

\echo '0004 PIVOT ASSERTIONS PASSED'

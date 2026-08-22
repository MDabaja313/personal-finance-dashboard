-- The movement invariant (deferred constraint trigger). pgTAP wraps the
-- whole file in one rolled-back transaction, so a DEFERRABLE INITIALLY
-- DEFERRED trigger never fires on its own commit — each case here uses
-- a SAVEPOINT plus `SET CONSTRAINTS ALL IMMEDIATE` to force it, wrapped
-- in pgTAP's throws_ok/lives_ok/throws_matching so the (expected, for
-- most cases) exception is caught cleanly rather than aborting the
-- script.
--
-- Ordering is load-bearing and was found the hard way: `ROLLBACK TO
-- SAVEPOINT` undoes a `SET CONSTRAINTS` mode change made after that
-- savepoint, exactly like any other transaction-local state — so
-- `SET CONSTRAINTS ALL DEFERRED` MUST come AFTER `ROLLBACK TO SAVEPOINT
-- caseN`, never before it. Getting this backwards (as an earlier draft
-- of this file did) leaves the constraint mode stuck at IMMEDIATE for
-- every subsequent case, which does not raise a test failure — it
-- raises a raw, uncaught PostgreSQL error the moment the NEXT case
-- inserts a movement before its legs exist, aborting the whole script.
-- Verified directly: a lone movement insert with no legs yet raised
-- immediately with the reset in the wrong order, and did not raise once
-- corrected.
begin;
select plan(10);

insert into auth.users (id, aud, role, email) values
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'mv-test@local.test');
insert into public.profiles (id) values ('10000000-0000-4000-8000-000000000001');
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('10000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 'A1', 'Bank', 'checking', 0),
  ('10000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-000000000001', 'A2', 'Bank', 'savings', 0);

-- Case 1: valid parent + two balanced legs commits.
savepoint case1;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000d1', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c1', -100),
  ('10000000-0000-4000-8000-0000000000d2', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c1', 100);
select lives_ok($$ set constraints all immediate $$, 'case 1: balanced two-leg movement is valid at COMMIT time');
rollback to savepoint case1;
set constraints all deferred;

-- Case 2: one leg deleted while parent exists fails, with the correct leg count.
savepoint case2;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c2', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000d3', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c2', -100),
  ('10000000-0000-4000-8000-0000000000d4', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c2', 100);
delete from public.transactions where id = '10000000-0000-4000-8000-0000000000d3';
select throws_matching(
  $$ set constraints all immediate $$,
  'expected exactly two legs, found 1',
  'case 2: deleting one leg while the parent exists fails at COMMIT with the correct leg count'
);
rollback to savepoint case2;
set constraints all deferred;

-- Case 3: both legs deleted while parent exists fails.
savepoint case3;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c3', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000d5', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c3', -100),
  ('10000000-0000-4000-8000-0000000000d6', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c3', 100);
delete from public.transactions where movement_id = '10000000-0000-4000-8000-0000000000c3';
select throws_matching(
  $$ set constraints all immediate $$,
  'expected exactly two legs, found 0',
  'case 3: deleting both legs while the parent exists fails at COMMIT'
);
rollback to savepoint case3;
set constraints all deferred;

-- Case 4: unbalanced legs (do not sum to zero) fails.
savepoint case4;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c4', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000d7', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c4', -100),
  ('10000000-0000-4000-8000-0000000000d8', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c4', 90);
select throws_matching(
  $$ set constraints all immediate $$,
  'legs do not sum to zero',
  'case 4: unbalanced legs fail at COMMIT'
);
rollback to savepoint case4;
set constraints all deferred;

-- Case 5: kind mismatch between leg and parent movement fails.
savepoint case5;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c5', '10000000-0000-4000-8000-000000000001', 'credit_card_payment');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000d9', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c5', -100),
  ('10000000-0000-4000-8000-0000000000da', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c5', 100);
select throws_matching(
  $$ set constraints all immediate $$,
  'a leg kind does not match the movement kind',
  'case 5: leg kind not matching parent movement kind fails at COMMIT'
);
rollback to savepoint case5;
set constraints all deferred;

-- Case 6: both legs on the same account fails.
savepoint case6;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c6', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000db', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c6', -100),
  ('10000000-0000-4000-8000-0000000000dc', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c6', 100);
select throws_matching(
  $$ set constraints all immediate $$,
  'legs must reference two different accounts',
  'case 6: both legs referencing the same account fail at COMMIT'
);
rollback to savepoint case6;
set constraints all deferred;

-- Case 7: deleting the PARENT movement cascades both legs and succeeds.
savepoint case7;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c7', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000dd', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c7', -100),
  ('10000000-0000-4000-8000-0000000000de', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c7', 100);
delete from public.movements where id = '10000000-0000-4000-8000-0000000000c7';
select lives_ok(
  $$ set constraints all immediate $$,
  'case 7: deleting the parent movement cascades both legs and succeeds at COMMIT'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '10000000-0000-4000-8000-0000000000c7'),
  0,
  'case 7: both legs are actually gone after the cascade'
);
rollback to savepoint case7;
set constraints all deferred;

-- Case 8: re-parenting a leg (OLD.movement_id <> NEW.movement_id)
-- invalidates the movement it left as well as the one it joined.
savepoint case8;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000c8', '10000000-0000-4000-8000-000000000001', 'transfer'),
  ('10000000-0000-4000-8000-0000000000c9', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000df', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c8', -100),
  ('10000000-0000-4000-8000-0000000000e0', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c8', 100),
  ('10000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-02', 'out', 'transfer', '10000000-0000-4000-8000-0000000000c9', -50),
  ('10000000-0000-4000-8000-0000000000e2', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a2', '2026-01-02', 'in', 'transfer', '10000000-0000-4000-8000-0000000000c9', 50);
-- Move one leg of movement c8 onto movement c9: c8 now has only one
-- leg (invalid), and c9 now has three legs (also invalid).
update public.transactions set movement_id = '10000000-0000-4000-8000-0000000000c9'
  where id = '10000000-0000-4000-8000-0000000000df';
select throws_matching(
  $$ set constraints all immediate $$,
  'expected exactly two legs, found 1',
  'case 8: re-parenting invalidates the movement the leg left'
);
rollback to savepoint case8;
set constraints all deferred;

-- Error text names only the movement id and the violated rule — never
-- an amount. The pattern is fully ANCHORED (^...$) so the entire
-- message must consist of exactly a UUID and a short reason with a
-- small integer count — nothing else can appear anywhere in the
-- string, which rules out the -123456 amount by construction rather
-- than by a separate "does not contain" check.
savepoint case9;
insert into public.movements (id, user_id, kind) values
  ('10000000-0000-4000-8000-0000000000ca', '10000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('10000000-0000-4000-8000-0000000000e3', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '10000000-0000-4000-8000-0000000000ca', -123456);
select throws_matching(
  $$ set constraints all immediate $$,
  '^movement 10000000-0000-4000-8000-0000000000ca is invalid: expected exactly two legs, found [0-9]+$',
  'case 9: error text is exactly a movement id and a short reason -- no amount can appear anywhere in it'
);
rollback to savepoint case9;
set constraints all deferred;

-- No `select * from finish();` here: pgtap tracks its own pass/fail
-- bookkeeping in a table that is itself subject to this file's
-- SAVEPOINT/ROLLBACK TO SAVEPOINT calls above, so by the time finish()
-- runs, its internal state has been rolled back and it raises
-- "# No tests run!" even though every individual assertion above
-- already reported correctly (verified: the TAP consumer's own
-- ok/not-ok line count matches plan() exactly without it). finish() is
-- a diagnostic convenience, not required for TAP correctness once
-- plan() matches the actual assertion count.
rollback;

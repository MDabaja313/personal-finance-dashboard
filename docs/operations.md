# Operations

A practical runbook for running this application day to day, written for its one owner — not a
generic SaaS on-call guide. It assumes you've read [README.md](../README.md) for orientation and
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) for what's actually shipped. This is CP8A's
deliverable: the application is fully writable (Phase 7 CP1–CP8A) but **not yet deployed** —
hosted verification and the actual Vercel/Supabase go-live are CP8B, tracked at the bottom of this
document.

## Contents

1. [Normal use](#1-normal-use)
2. [Architecture, in one paragraph](#2-architecture-in-one-paragraph)
3. [Production environment variables](#3-production-environment-variables)
4. [Provisioning the hosted owner](#4-provisioning-the-hosted-owner)
5. [Database migrations](#5-database-migrations)
6. [Backup and export](#6-backup-and-export)
7. [Recovery](#7-recovery)
8. [Known limitations](#8-known-limitations)
9. [Unattended maintenance](#9-unattended-maintenance)
10. [CP8B — what remains before going live](#10-cp8b--what-remains-before-going-live)

---

## 1. Normal use

Once deployed (CP8B), using the application day to day requires **nothing** beyond a browser:

- Open the deployed site's URL.
- Sign in with the one provisioned owner's email and password.
- Use it. Every read and write goes straight to the hosted Supabase project.

No local Supabase, no Docker, no VS Code, no terminal. Those are all *development* tools, needed
only when you're changing the application itself (see the main [README.md](../README.md) for the
local dev/test commands) — never for ordinary use of the deployed app.

## 2. Architecture, in one paragraph

**Vercel** hosts the Next.js application (App Router, Server Actions, Server Components).
**Supabase** hosts the Postgres database, Row Level Security policies, and authentication (email +
password, single provisioned owner, no public signup). Every read and write is scoped to the
signed-in owner by RLS *and* an explicit `user_id` predicate in the query — defense in depth, not
either one alone. Two pieces of maintenance run unattended, inside the database itself, on a daily
`pg_cron` schedule: rolling the bill-occurrence horizon forward, and keeping the current month's
net-worth snapshot fresh (§9). Nothing about the application depends on a server that is "always
on" outside of Vercel's and Supabase's own hosting — there is no separate worker process, no queue,
no cron service outside the database.

## 3. Production environment variables

Vercel needs exactly two, both already documented in [.env.example](../.env.example) and
[README.md](../README.md#environment) — **names only**, never values, in this document or any
other tracked file:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Both are browser-safe by design (`lib/supabase/env.ts` is the only module that reads them) —
"publishable" describes where it's safe to embed the key, not what it's allowed to touch, which is
governed entirely by the database's grants and RLS policies
([docs/rls-policies.md](rls-policies.md)). **No `service_role` key, database password, or JWT
secret belongs in Vercel's environment, ever** — `service_role` never runs in application code
(`lib/auth/posture.test.ts` is a standing regression test for exactly this).

`LOCAL_OWNER_EMAIL`, `LOCAL_OWNER_PASSWORD`, and `OWNER_TIMEZONE` are **local development and test
tooling only** (`scripts/provision-owner.ts`, `scripts/verify-auth.ts`, the `test:parity` and
`test:mutations` harnesses). No file under `app/**`, `components/**`, or `lib/**` reads any of the
three — verified directly (`git grep`), not merely assumed. They have no place in Vercel's
environment and provisioning the hosted owner does not use them (§4).

## 4. Provisioning the hosted owner

Public signup is disabled, both locally and hosted, permanently — there is no signup route in the
application and never will be (`docs/auth-design.md §1`). The hosted owner is created once, by
hand, using the existing provisioning artifact: `supabase/provisioning/owner.sql`, run directly
against the hosted project (idempotent — safe to run again if you ever need to confirm the row
shape, though it should only ever be *needed* once). See that file and
`docs/auth-design.md §1`/§2 for the exact mechanics — this document doesn't restate them.

## 5. Database migrations

**Inspect what's pending, without changing anything:**

```bash
npx supabase migration list          # compares local migration files against the linked hosted project
npx supabase db push --dry-run       # prints exactly which migration files would be pushed, and applies nothing
```

Both require the CLI to already be authenticated and the project already linked
(`npx supabase link`) — if a login is needed, run the provider's own login flow yourself in your
own terminal/browser; never paste a token or credential into an assistant session.

**Apply pending migrations:**

```bash
npx supabase db push
```

This applies every local migration file the hosted project doesn't yet have, in order, and nothing
else. It does **not** run `supabase/seed.sql` — seeding is local-only, deliberately: `db push`
never applies a seed, and there is no hosted seed step to accidentally run.

**Never** run `supabase db reset` against a linked hosted project — that command is for the local
database only and this repository's tooling (`npm run db:reset`, `npm run auth:reset-local`)
never targets anything but `127.0.0.1`.

## 6. Backup and export

The Supabase CLI can dump the hosted project directly:

```bash
npx supabase db dump --linked --file <path-outside-this-repo>/backup-$(date +%Y%m%d).sql
```

Save the output **outside this repository** — never commit a database dump. `.gitignore` has no
rule protecting a stray dump file dropped inside the working tree, so treat the destination path
as deliberately as the command itself. `--data-only` produces a smaller data-only dump if you
don't need schema alongside it; `--dry-run` prints the underlying `pg_dump` invocation without
running it, useful for confirming exactly what a real run would do first.

This repository makes no claim about Supabase's own automatic backup behavior for your specific
plan — check the Supabase dashboard's Database → Backups page for what your project's plan
actually provides, and don't assume point-in-time recovery is available unless that page confirms
it.

## 7. Recovery

**Code rollback** (Vercel) and **schema rollback** (the database) are two different operations
with two different risk profiles — don't conflate them:

- **Code**: Vercel keeps prior deployments; redeploying an earlier one is fast and safe on its own.
- **Schema**: migrations in this repository are **forward-only**. There is no `supabase migration
  down` step exercised anywhere in this project's tooling, and no migration file has ever been
  edited after the fact (every checkpoint from CP2 onward is additive — see DEVELOPMENT_PLAN.md).
  Rolling a deployed schema backward means hand-writing a new forward migration that undoes the
  change, reviewed with the same care as any other migration — never editing or deleting an
  applied one.

If code and schema drift out of sync (a code rollback now expects a schema that no longer exists,
or vice versa), fix it by moving *forward* — a new migration, a new deployment — never by editing
history.

**Restoring data** from a backup taken per §6 is, at a high level: provision a scratch Supabase
project (or use the CLI against a local instance first to rehearse), restore the dump into it, and
verify it looks right before ever pointing production traffic at restored data. This repository
does not script that restore path — it is infrequent enough, and consequential enough, that it
should stay a deliberate, reviewed, manual operation rather than a command someone runs on
autopilot.

## 8. Known limitations

- **The current month's net-worth trend point can go stale**, in exactly two documented,
  reachable states (CP5): aggregate assets below zero, or aggregate liabilities above zero
  internally. When either happens, the ledger write that caused it still succeeds and every live
  balance stays correct — only the *stored snapshot* for the current month is left unchanged
  rather than corrupted. `/dashboard` and `/analytics` now show a plain-language notice
  ("This month's trend point is out of date...") on the net-worth trend chart whenever the current
  month's stored snapshot disagrees with live totals or is missing outright
  (`lib/finance/trends.ts`'s `snapshotHealth()`) — no SQLSTATE, no internal detail, ever reaches
  that notice. Live balances shown everywhere else in the app are unaffected and remain
  authoritative.
- **`merchant` search has no `pg_trgm` index** (deferred since Phase 6) — fine at this owner's
  actual data volume, a future performance item if it ever isn't.
- **No historical snapshot rebuild surface** — `private.write_net_worth_snapshots_for_range`
  exists but has no public wrapper; backfilling or repairing a *past* month's snapshot after a
  backdated edit is an operator action (direct SQL as a Supabase admin), not something the
  application UI can do. This is unchanged by CP8A's daily maintenance, which only ever touches
  the *current* month.

## 9. Unattended maintenance

Two `pg_cron` jobs run daily against the hosted database, both added in CP8A
(`supabase/migrations/20260901120001_scheduled_maintenance.sql`) and both a single call to a
narrow, `SECURITY DEFINER` function owned by the existing `finance_snapshot_writer` role — no
`service_role`, no new privilege for `authenticated`, no browser-reachable surface. See
[database-schema.md](database-schema.md#phase-7-cp8a--pg_cron-is-finally-scheduled-and-it-is-the-writer-this-section-always-intended)
for the full design.

| Job | What it does |
|---|---|
| `bill-schedule-maintenance` | Tops up every active bill's scheduled occurrences to roughly a year out, so a bill nobody ever edits again doesn't silently run out (CP7's documented limitation). Never rewrites a paid or skipped occurrence, never deletes anything. |
| `current-snapshot-maintenance` | Refreshes every owner's current-month net-worth snapshot, so a new month or a previously-failed refresh eventually catches up without anyone having to make a write first. A sign-guard failure (§8) for one owner never blocks another owner's refresh, and never touches that owner's prior snapshot row. |

**Verifying a job exists and when it last ran**, from the Supabase SQL editor (or `psql` against
the hosted connection string) — read-only, safe to run any time:

```sql
select jobid, jobname, schedule, active from cron.job order by jobname;

select jobid, status, start_time, end_time, return_message
from cron.job_run_details
order by start_time desc
limit 20;
```

If a job is missing after `db push`, re-check `npx supabase migration list` (§5) — the migration
that creates it must actually be applied. If a job exists but its recent runs show a non-success
`status`, `return_message` carries a summary (counts, not figures — see the migration file's own
comments) and is safe to read without exposing account data.

## 10. CP8B — what remains before going live

CP8A is preparation and verification only. **Nothing has been deployed and no hosted migration has
been applied.** What's actually left, in order:

1. **Authenticate the Supabase CLI and Vercel CLI/dashboard**, in your own terminal/browser —
   never by pasting a token into an assistant session.
2. **Apply the pending hosted migrations** (§5) — as of this checkpoint, every Phase 7 migration
   (CP2 through CP8A) is pending on the linked hosted project; only the eight Phase 4 migrations
   are applied there today (verified via `npx supabase migration list`, read-only).
3. **Provision the hosted owner** (§4), if not already done.
4. **Deploy to Vercel**, set the two environment variables (§3), and confirm the build succeeds
   against the real hosted project rather than the CI workflow's placeholder values.
5. **Run through the CP8A smoke-test checklist** (every route, sign-in/sign-out, security headers,
   protected-page cache posture) against the live deployment, the same way it was proven locally
   against `npm run build && npm run start` during CP8A.
6. **Confirm both `pg_cron` jobs exist and have run at least once** (§9) after the first day live.

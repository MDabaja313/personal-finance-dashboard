# Authentication Design

Documentation only — no `lib/supabase/**`, no `proxy.ts`, no auth implementation exists yet. See
[docs/rls-policies.md](rls-policies.md) for the object-privilege/RLS layer this design sits above,
and [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) for phase sequencing (auth lands in Phase 5,
after schema/RLS in Phase 4).

## Contents

1. [Provider and provisioning model](#1-provider-and-provisioning-model)
2. [profiles relationship](#2-profiles-relationship)
3. [Default-category provisioning](#3-default-category-provisioning)
4. [Client responsibilities: browser, server, proxy](#4-client-responsibilities-browser-server-proxy)
5. [Verified identity, never `getSession()`](#5-verified-identity-never-getsession)
6. [`proxy.ts` — session refresh, not an authorization boundary](#6-proxyts--session-refresh-not-an-authorization-boundary)
7. [The `app/(app)/layout.tsx` guard](#7-the-apphapplayouttsx-guard)
8. [DAL authorization](#8-dal-authorization)
9. [RLS as the final defense layer](#9-rls-as-the-final-defense-layer)
10. [Server Actions in Phase 7](#10-server-actions-in-phase-7)
11. [No `service_role` in application code](#11-no-service_role-in-application-code)
12. [Environment-variable ownership](#12-environment-variable-ownership)
13. [Trusted `SECURITY DEFINER` principles for system jobs](#13-trusted-security-definer-principles-for-system-jobs)

---

## 1. Provider and provisioning model

- **Supabase Auth, email + password only.** No OAuth, no magic links, no other providers.
- **One user, provisioned manually** in the Supabase dashboard (or via the Supabase CLI at setup
  time) — not through the application.
- **Public signup is disabled** at the project level. There is no self-service account creation
  for this application.
- **No signup route exists in the application.** The `(auth)` route group contains `/login` only.

This matches the locked architectural decision: the application is single-user in practice, but
the schema underneath (`user_id` + RLS on every table, per
[docs/rls-policies.md](rls-policies.md)) is multi-tenant-correct regardless, so nothing about the
data model needs to change if that ever expands.

---

## 2. `profiles` relationship

`profiles` is 1:1 with `auth.users` — `profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`,
detailed in [docs/database-schema.md](database-schema.md#4-table-by-table-columns). It exists to
hold `timezone`, which nothing in `auth.users` provides and which the production `getToday()`
seam needs (`database-schema.md §10`).

**The `profiles` row is created during provisioning, not by the application.** No `authenticated`
INSERT policy exists on `profiles` (`rls-policies.md §4`) — the single provisioned user's profile
row is created once, by an administrator, alongside the `auth.users` row itself.

---

## 3. Default-category provisioning

Categories are per-user, not a global shared table (`database-schema.md §2`, `§4`). For the one
provisioned user, **default categories are seeded once, at provisioning time**, from the same set
currently hardcoded in `lib/mock/categories.ts` (Salary, Interest, Housing, Groceries, Dining,
Transportation, Entertainment, Shopping, Utilities, Healthcare, Subscriptions, Insurance).

This is a provisioning-time data-loading step (part of Phase 4's `seed.sql`, tied to the one
known user id), not an application code path — there is no "new user" signup flow in this design
that would need an automatic seeding trigger. If the application ever supports self-service
signup in the future, a category-seeding trigger on `auth.users` insert would need to be added at
that time; it is out of scope here because signup itself is out of scope here.

---

## 4. Client responsibilities: browser, server, proxy

`lib/supabase/**` (Phase 5) is the **only** layer permitted to read Supabase environment
variables or construct a Supabase client — the `no-restricted-properties` ESLint rule blocking
`process.env` outside `lib/data/**` at
[eslint.config.mjs](../eslint.config.mjs) is already pre-armed for this, and a parallel
`no-restricted-imports` rule already blocks `app/**` and `components/**` from importing
`@/lib/supabase` directly (it is currently a no-op only because the directory doesn't exist yet).

Three clients, one per execution context:

| Client | Runs in | Responsibility |
|---|---|---|
| Browser client | Client Components | Session-aware client for any client-side Supabase interaction — narrow surface, since this app is Server-Component-first |
| Server client | Server Components, Server Actions, Route Handlers | Reads the session from the request's cookies via Next.js 16's **async** `cookies()` (per `AGENTS.md` — this is a breaking-change area from prior Next.js versions) |
| Proxy client | `proxy.ts` (Next.js 16's renamed `middleware.ts`, per `AGENTS.md`) | Refreshes the session cookie on navigation — see §6 |

---

## 5. Verified identity, never `getSession()`

**Correction to an earlier, more rigid version of this rule.** The prior wording locked
`getUser()` as the *only* acceptable check. Current Supabase SSR guidance recommends a more
precise rule that still forbids the same mistake but doesn't over-specify the mechanism:

> **Every server-side authorization check uses verified claims / a verified user identity.
> `getSession()` is never used for authorization anywhere in this application** — cookie-backed
> session data is not itself a verified identity source; it can be stale, forged, or otherwise no
> longer valid, and `getSession()` does not check.

Two verified-identity paths are both legitimate, for different situations:

- **`supabase.auth.getClaims()` — the normal path for protecting pages and user data**, including
  the layout guard (§7) and `proxy.ts` (§6). It verifies the access token's signature locally
  (no network round-trip to the Auth server is required to validate the JWT itself), which is
  what makes it the right default for a check that runs on effectively every request.
- **`supabase.auth.getUser()` — still valid, and preferred specifically when an up-to-date `Auth`
  user record is actually needed** (e.g., confirming the account hasn't been deleted or disabled
  server-side since the token was issued), since it does make a live call to the Auth server.

Neither path is `getSession()`, and that's the part of this rule that doesn't change: a request
that trusts the cookie's session payload as its authorization decision — rather than a verified
claim or a verified user record — is trusting exactly the value that can be stale or forged.

---

## 6. `proxy.ts` — session refresh, not an authorization boundary

Next.js 16 renames `middleware.ts` to `proxy.ts` (per `AGENTS.md` — read the resolved
`node_modules/next/dist/docs/` before implementing, since this is a breaking-change area from
prior training data). In Phase 5, `proxy.ts` uses the proxy Supabase client, calling
**`getClaims()`** (§5) as current Supabase SSR guidance recommends for this exact position in the
request lifecycle, to refresh the session cookie on every navigation, so a Server Component later
in the request has an up-to-date session available.

**`proxy.ts` is explicitly not an authorization boundary.** It refreshes tokens; it does not
decide who is allowed to see what. Treating proxy-level presence-of-a-session as sufficient
authorization would be a mistake — the actual authorization decision is made at the layout guard
(§7) and re-verified at the DAL (§8), both using verified identity per §5.

---

## 7. The `app/(app)/layout.tsx` guard

[app/(app)/layout.tsx](../app/(app)/layout.tsx) previously carried a comment referencing the old
"Phase 3" numbering for authentication; that comment was corrected as part of this phase's
cleanup to point at Phase 5, where the guard is actually implemented (see
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)).

In Phase 5, this layout verifies identity via `getClaims()` (§5 — the recommended path for
page-level protection) and redirects to `/login` if no valid, verified user is present, before
rendering any child route. Every one of the 8 existing routes sits under this layout, so this
single guard point covers the entire authenticated application surface without touching each
page individually.

---

## 8. DAL authorization

**`lib/data/**` operates from a verified request/user identity on every call, not just once at
the layout boundary.** This matters specifically because of §10: Server Actions (Phase 7) are
independently reachable HTTP endpoints — a client can call one directly without ever rendering
the page whose layout would otherwise have gated access. The layout guard protects page
*rendering*; it does not protect a Server Action invoked out-of-band. The DAL is the layer both
paths share, so it is where authorization re-verification actually has to live to be reliable.

**This does not mean every individual DAL function independently issues its own fresh network
identity check.** The verified identity (§5) is established once per request — at the layout
guard for a page render, or at the top of a Server Action for a direct invocation — and that
already-verified request-scoped context is what `lib/data/**` functions consume and scope their
queries to (`auth.uid()`/the verified user id), rather than each function repeating
authentication work the request has already done. What must not happen is a DAL function trusting
an *unverified* value (e.g., an id passed as a plain argument with no verified identity behind
it) — the requirement is that the context is verified and request-scoped, not that verification
itself is repeated per function call.

---

## 9. RLS as the final defense layer

Full policy design in [docs/rls-policies.md](rls-policies.md). In the authentication chain, RLS
is the layer that holds even if every application-level check above it has a bug: proxy refresh →
layout identity guard (§5, §7) → DAL re-verification (§8) → **RLS**, enforced by Postgres itself
regardless of what the application code did or didn't check correctly. This is why RLS is
`FORCE`d on every user-owned table (`rls-policies.md §8`) rather than treated as a convenience
layer that trusted application code could reasonably skip.

---

## 10. Server Actions in Phase 7

Server Actions do not exist yet — no mutation of any kind exists in this codebase today. When
Phase 7 introduces them: **a Server Action is an independently reachable endpoint**, callable
directly over the network without the page that renders its trigger UI ever having loaded. This
is precisely why §8 requires DAL-level re-verification rather than relying on the caller having
passed through the layout guard — a Server Action's authorization must not assume it did.

---

## 11. No `service_role` in application code

`service_role` bypasses RLS entirely and is intended for trusted administrative/server-side
tooling — never for logic the Next.js application itself runs, in any phase. This holds
identically here as in [docs/rls-policies.md §12](rls-policies.md#12-no-service_role-in-application-code):
restated in both documents because it is a rule about *where credentials are used*, which is an
auth-design concern, as much as it is a rule about *what those credentials bypass*, which is an
RLS concern.

---

## 12. Environment-variable ownership

`lib/supabase/**` is the only layer permitted to read Supabase environment variables
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and any server-only secret
added in Phase 4/5) — consistent with the existing architecture invariant in
[CLAUDE.md](../CLAUDE.md) ("`lib/supabase/**` — the only layer that reads Supabase env vars /
constructs clients"). `.env.example` documents the two `NEXT_PUBLIC_*` placeholders today, using
Supabase's current publishable-key naming (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, superseding
the older `_ANON_KEY` naming) since this will be a newly provisioned project. The public project
URL and publishable key are browser-safe **only in conjunction with** the least-privilege grants
(`rls-policies.md §3`) and RLS (`rls-policies.md §4`, §8) documented elsewhere — the key being
"publishable" describes where it's safe to embed it, not what it's allowed to touch; that's still
governed entirely by grants and policies. Any additional secret needed for the snapshot writer or
other trusted server-side job (`rls-policies.md §9`) must be a server-only variable, never
`NEXT_PUBLIC_*`, and must never be read outside `lib/supabase/**`.

---

## 13. Trusted `SECURITY DEFINER` principles for system jobs

The monthly net-worth snapshot writer (`database-schema.md §14`, `rls-policies.md §9`) is a
database-level trusted job, not an application-layer concern — but its trust boundary is
authentication-adjacent enough to restate here: it is the one piece of logic in this system that
runs **without** an authenticated user context (`auth.uid()` is null under `pg_cron`), and so it
cannot lean on any of the layers §5–§9 describe. Its hardening — fixed `search_path`,
fully-qualified references, minimal `EXECUTE`, explicit in-function user scoping, never assuming
`auth.uid()` — is specified in full in
[docs/rls-policies.md §9](rls-policies.md#9-security-definer-bypassrls-and-the-snapshot-writer).
The exact database role/identity that owns it is an explicit **Phase 4 provisioning decision**,
not settled here.

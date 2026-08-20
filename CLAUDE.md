# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

**Current phase:** Phase 0 (foundation) complete — app shell + mock-backed dashboard. No Supabase, no auth, no persistence yet.

## Commands

- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — run ESLint
- `npm run typecheck` — `tsc --noEmit`

No test framework is configured yet (Vitest arrives in Phase 2, scoped to `lib/finance/`).

## Stack notes

- **App Router**, `@/*` aliased to the repo root.
- **Tailwind CSS v4, CSS-first** — no `tailwind.config.*`; tokens live in `app/globals.css` via `@theme inline`. Dark mode is the `.dark` class (shadcn), not a media query.
- **shadcn/ui** — primitives in `components/ui/**` are generated (`npx shadcn@latest add ...`); don't hand-edit them.
- Next.js 16: `middleware.ts` is renamed `proxy.ts`; `cookies()` is async. See `AGENTS.md`.

## Architecture invariants

- **Money is integer cents**, branded `Cents` (`lib/types`). Never floats. Convert to decimal only in `lib/format/currency.ts`. A `bigint` crossing the DB→TS boundary must pass a `Number.isSafeInteger` check — never silently coerced.
- **Dates are `'YYYY-MM-DD'` strings.** Never `new Date('YYYY-MM-DD')` on a financial date — it parses as UTC and can shift a day in local time. Use `lib/format/date.ts`.
- **Layer boundaries** (enforced by `eslint.config.mjs` where the layer exists):
  - `lib/data/**` — the only layer that queries the database. `'server-only'`, returns DTOs.
  - `lib/supabase/**` — the only layer that reads Supabase env vars / constructs clients.
  - `components/**` — UI + local state/interactivity only. No DB access, no `process.env`, no business logic.
  - `lib/finance/**` — pure calculations, no I/O, takes `today` as a parameter (never reads the clock).
- **Auth:** use `getUser()`, never `getSession()`, for server-side authorization. RLS is enabled on every table even though this is single-user — the anon key is public. `service_role` never runs in application code.
- **Server Actions are independently reachable endpoints** — re-verify auth and row ownership inside the DAL, not just at the page level.

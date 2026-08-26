import "server-only";

import { cache } from "react";

import { unauthorized } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

/**
 * The single seam between `lib/data/**` and `lib/supabase/**`.
 *
 * This is the **only** module under `lib/data/` permitted to import a Supabase
 * client — enforced two ways, both narrowed in Phase 6 Checkpoint 1: an
 * ESLint `no-restricted-imports` rule over `lib/data/**` that exempts exactly
 * this path, and the static allowlist in `lib/auth/posture.test.ts`. Keeping
 * it to one file is also what makes the parity suite honest: Checkpoint 2
 * mocks this module and nothing else, so every mapper, query builder, ordering
 * chain, and error path under test is the real production code.
 *
 * ## Security does not depend on render order
 *
 * `app/(app)/layout.tsx` is the *navigation-level* guard — it decides where an
 * unauthenticated visitor is sent. It is not, and must not become, the thing
 * that makes a DAL read safe: React may run layout and page work
 * concurrently, and a Server Action is an independently reachable endpoint
 * that never rendered a layout at all.
 *
 * So the invariant here is unconditional: **every** Supabase-backed DAL read
 * calls `getOwnerId()` and gets a verified owner *before* issuing its query,
 * failing closed with `unauthorized()` if there isn't one. That holds whether
 * the layout runs first, runs concurrently, or never runs.
 *
 * `React.cache` is an efficiency layer on top of that invariant, never a
 * substitute for it. The first call in a request performs the real
 * verification; there is no path to an owner id that bypasses `getOwnerId()`.
 */

/**
 * One Supabase client per request.
 *
 * `cache()` is request-scoped within the RSC render pass, so this is not
 * module-level mutable state — there is no client or user id held between
 * requests. Outside a React request scope (a unit test, a script) it simply
 * degrades to per-call construction: correct, only less deduplicated.
 */
export const getDataClient = cache(async () => createClient());

/**
 * The verified owner id every read is scoped to.
 *
 * Authorization goes through `getClaims()`, which verifies the access token's
 * signature locally. `getSession()` is never used to authorize anything —
 * cookie-backed session data is not a verified identity (docs/auth-design.md
 * §5).
 *
 * **Throws, never redirects.** Navigation control flow belongs to the route
 * layer; the DAL raises a typed `AppError` so a Server Action calling into it
 * gets an error rather than a surprise redirect. The raw auth error travels as
 * `cause` (server-side only) and never reaches the message.
 *
 * Obtains its client through `getDataClient()` rather than constructing its
 * own, so a request has exactly one client and one `cookies()` read.
 */
export const getOwnerId = cache(async (): Promise<string> => {
  const supabase = await getDataClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error) throw unauthorized("Not authenticated.", { cause: error });
  if (!data) throw unauthorized();

  const { sub } = data.claims;
  if (typeof sub !== "string" || sub === "") throw unauthorized();

  return sub;
});

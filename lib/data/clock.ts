import "server-only";

import { cache } from "react";

import { calendarDateInTimeZone } from "@/lib/data/calendar";
import { mapDbError } from "@/lib/data/db-errors";
import type { ProfileTimezoneRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { dataIntegrity } from "@/lib/errors";
import type { CalendarDate } from "@/lib/types";

/**
 * Today's calendar date, in the owner's own timezone.
 *
 * Phase 6 Checkpoint 4: the last oracle-backed function. `MOCK_TODAY` is gone
 * from production — the date is now the real current instant resolved through
 * `profiles.timezone` (docs/database-schema.md §10), which is why the fixture
 * oracle's `getToday()` and this one are *intentionally* different values now
 * and are no longer compared to each other.
 *
 * There is deliberately **no development-only `MOCK_TODAY` branch**. A clock
 * that behaves differently in dev is a clock nothing can be verified against;
 * seeded data aging out of "this month" as real time advances is the correct,
 * visible consequence, and every page already has an empty state for it.
 *
 * `lib/finance/**` still never reads a clock — `today` remains an explicit
 * parameter everywhere, supplied from here.
 *
 * ## Why the timezone is required, not defaulted
 *
 * A verified owner with no profile row (or an unusable zone in it) is a
 * provisioning/data-integrity failure, so it fails loudly. Falling back to UTC
 * would be the worst possible behavior: it "works", and silently shows the
 * wrong calendar day — and therefore the wrong "this month" totals, budget
 * period, and overdue-bill grouping — to anyone whose zone has already rolled
 * over.
 *
 * ## Request scoping
 *
 * `cache()` for the same reason `getDataClient`/`getOwnerId` use it: one
 * `profiles` read per request, and — more importantly — one *answer* per
 * request, so a page that resolves `today` in several places cannot straddle
 * midnight and render two different dates. Outside a React request scope (a
 * unit test, a script) it degrades to per-call evaluation, which is exactly
 * what a test wants.
 */
export const getToday = cache(async (): Promise<CalendarDate> => {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  // Explicit `id = ownerId` on top of the `profiles_select_own` policy, per
  // the unconditional DAL rule — RLS is the floor, not the filter.
  const { data, error } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", ownerId);

  if (error) throw mapDbError(error, "the owner profile");

  const rows = data as ProfileTimezoneRow[];
  // Not `.single()`: PGRST116's "no rows" is indistinguishable from a
  // legitimately empty result at the transport layer, and this relation has
  // exactly one right answer. Zero rows means the owner was never provisioned;
  // more than one would mean the primary key stopped being one.
  if (rows.length !== 1) {
    throw dataIntegrity("Expected exactly one owner profile.");
  }

  return calendarDateInTimeZone(new Date(), rows[0].timezone);
});

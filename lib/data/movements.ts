import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { calendarDateFrom, centsFrom, enumFrom } from "@/lib/data/mappers";
import type { MovementLegRow, MovementRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { dataIntegrity } from "@/lib/errors";
import type { CalendarDate, Cents } from "@/lib/types";
import { MOVEMENT_KINDS, type MovementKind } from "@/lib/types/enums";

/**
 * The read half of the movements DAL — new in Phase 7 CP4.
 *
 * `public.movements` had no `authenticated` grant at all through Phase 6,
 * because nothing read it: `Transaction.movementId` is a plain column on the
 * leg, and every leg is already visible wherever its own `account_id` puts it.
 * CP4 is the first feature that needs the parent, and it needs it for exactly
 * one reason — **an edit form has to show the movement, not a leg.**
 *
 * ## Why a leg is not enough
 *
 * The `/transactions` list renders a bounded, cumulative window of the ledger
 * (`resolveRevealPage`), so on any given render a movement's two legs may
 * straddle the edge of it: the source leg is visible, the destination leg is
 * ten thousand rows further back. A form that reconstructed "from account", "to
 * account" and "amount" by pairing two rendered rows would therefore work by
 * accident, and would silently offer no edit control on exactly the pairs that
 * are hardest to find by hand.
 *
 * So `getMovements()` reads the pair by movement id — both legs, whatever the
 * page happens to be rendering — and returns the movement as the single object
 * the entry form actually collects: a kind, a date, two accounts, and one
 * positive magnitude.
 *
 * ## Shape and invariants
 *
 * The signed leg amounts are *not* on the DTO. `amountCents` is the magnitude,
 * and which account is `from` versus `to` is derived here from the sign, once,
 * rather than being re-derived by each consumer. That mirrors what the write
 * path does in the other direction: the form posts a magnitude and two account
 * roles, and `public.create_movement` derives `-magnitude`/`+magnitude` from
 * them.
 *
 * Anything that is not a well-formed pair is `data_integrity`, not a shrug.
 * `validate_movement()` guarantees exactly two legs summing to zero on two
 * different accounts, so a movement that fails those checks here means the
 * database contradicted its own invariant — which is a server fault, and reads
 * as "try again" rather than as "fix your input" through
 * `lib/actions/result.ts`'s classification.
 *
 * Every read follows the unconditional DAL rule: a verified `getOwnerId()`
 * first, then an explicit `user_id` predicate on top of RLS
 * (`movements_select_own`, `transactions_select_own`), then `mapDbError` before
 * `data` is touched.
 */

/**
 * One movement, in the shape the entry form collects and the mutation layer
 * compares against.
 */
export interface Movement {
  readonly id: string;
  readonly kind: MovementKind;
  readonly date: CalendarDate;
  /** The debited account — its leg is stored at `-amountCents`. */
  readonly fromAccountId: string;
  /** The credited account — its leg is stored at `+amountCents`. */
  readonly toAccountId: string;
  /** The debited leg's row id. Stable across edits. */
  readonly sourceLegId: string;
  /** The credited leg's row id. Stable across edits. */
  readonly destinationLegId: string;
  /** A strictly positive magnitude — never a signed leg amount. */
  readonly amountCents: Cents;
}

const MOVEMENT_COLUMNS = "id, kind";
/** The leg columns a movement is reconstructed from. `merchant` is derived, so it is not read back. */
const LEG_COLUMNS = "id, movement_id, account_id, date, amount_cents";

/**
 * The owned movements behind `ids`, each with both of its legs resolved.
 *
 * Batched rather than one-at-a-time because the caller is a list page holding
 * every movement id it just rendered: two queries for a whole page, not two per
 * row. An empty `ids` short-circuits to `[]` — auth is still verified, but
 * there is no query whose result is not already known.
 *
 * Ids that name no visible movement are simply absent from the result. A
 * foreign or deleted id produces zero rows through RLS either way, so "someone
 * else's movement" and "no such movement" are deliberately indistinguishable;
 * telling them apart would confirm the existence of another owner's row.
 *
 * Ordering: `id ASC`, a technical order only — the caller looks these up by id
 * and never renders them as a list, so there is no semantic order to promise.
 */
export async function getMovements(ids: readonly string[]): Promise<Movement[]> {
  const ownerId = await getOwnerId();

  // Deduplicated because a caller holding both legs of one pair naturally has
  // the same movement id twice.
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];

  const supabase = await getDataClient();

  const [parents, legs] = await Promise.all([
    supabase
      .from("movements")
      .select(MOVEMENT_COLUMNS)
      .eq("user_id", ownerId)
      .in("id", wanted)
      .order("id", { ascending: true }),
    supabase
      .from("transactions")
      .select(LEG_COLUMNS)
      .eq("user_id", ownerId)
      .in("movement_id", wanted)
      .order("id", { ascending: true }),
  ]);

  if (parents.error) throw mapDbError(parents.error, "movements");
  if (legs.error) throw mapDbError(legs.error, "movements");

  const legsByMovement = new Map<string, MovementLegRow[]>();
  for (const leg of legs.data as MovementLegRow[]) {
    // Non-null by construction — the query filtered on `movement_id` — but the
    // row type says nullable, and narrowing here is cheaper than an assertion.
    if (leg.movement_id === null) continue;
    const bucket = legsByMovement.get(leg.movement_id);
    if (bucket) bucket.push(leg);
    else legsByMovement.set(leg.movement_id, [leg]);
  }

  return (parents.data as MovementRow[]).map((row) =>
    toMovement(row, legsByMovement.get(row.id) ?? [])
  );
}

/**
 * One movement's parent row plus its legs → a `Movement`.
 *
 * Every failure here is `data_integrity` because every one of them is a
 * database invariant that did not hold: `validate_movement()` is a deferred
 * constraint trigger on both tables, so a committed movement with anything
 * other than two opposite-signed legs on two different accounts cannot exist.
 * Reaching one of these throws means the trigger was disabled or bypassed, not
 * that a caller asked for something odd.
 */
function toMovement(row: MovementRow, legs: readonly MovementLegRow[]): Movement {
  if (legs.length !== 2) {
    throw dataIntegrity(`Movement ${row.id} does not have exactly two legs.`);
  }

  const amounts = legs.map((leg) => centsFrom(leg.amount_cents, "transactions.amount_cents"));
  const sourceIndex = amounts[0] < 0 ? 0 : 1;
  const destinationIndex = 1 - sourceIndex;

  const sourceCents = amounts[sourceIndex];
  const destinationCents = amounts[destinationIndex];

  if (sourceCents >= 0 || destinationCents <= 0 || sourceCents + destinationCents !== 0) {
    throw dataIntegrity(`Movement ${row.id} does not have two opposite-signed legs.`);
  }

  const source = legs[sourceIndex];
  const destination = legs[destinationIndex];

  if (source.account_id === destination.account_id) {
    throw dataIntegrity(`Movement ${row.id} has both legs on one account.`);
  }

  // Both legs of one movement are always written with the same date — the RPC
  // writes them in a single INSERT — so either is the movement's date. Read
  // from the source leg, and cross-checked, because a disagreement would mean
  // a pair that no write path in this application could have produced.
  const date = calendarDateFrom(source.date, "transactions.date");
  if (calendarDateFrom(destination.date, "transactions.date") !== date) {
    throw dataIntegrity(`Movement ${row.id} has legs on two different dates.`);
  }

  return {
    id: row.id,
    kind: enumFrom(row.kind, MOVEMENT_KINDS, "movements.kind"),
    date,
    fromAccountId: source.account_id,
    toAccountId: destination.account_id,
    sourceLegId: source.id,
    destinationLegId: destination.id,
    amountCents: destinationCents,
  };
}

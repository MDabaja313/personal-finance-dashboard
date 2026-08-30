import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { isAppError } from "@/lib/errors";

/**
 * The current month's net-worth snapshot, kept up to date after a
 * balance-affecting write.
 *
 * The narrowest module in this layer: one RPC, no parameters, no table access
 * of any kind. `net_worth_snapshots` has no INSERT or UPDATE grant for
 * `authenticated` and never will — the row is written by
 * `private.write_net_worth_snapshot`, a Phase 4 `SECURITY DEFINER` function
 * owned by `finance_snapshot_writer` that this application cannot reach
 * directly (there is no `USAGE` on `private`). CP5 adds exactly one bridge to
 * it, `public.refresh_current_net_worth_snapshot()`, and this module is the
 * only thing in the codebase that names it.
 *
 * ## Why the refresh cannot be part of the write it follows
 *
 * PostgREST issues one statement per request, each in its own transaction, and
 * this is a *second* request. So the refresh is unavoidably a separate
 * transaction from the ledger or account write that made it necessary, and the
 * two can therefore succeed and fail independently. There is no arrangement
 * available here in which they commit together — a trigger on `transactions`
 * could do it, but it would run as the writing role inside every single write,
 * turn every snapshot failure into a failed ledger write, and put a whole-user
 * aggregate recomputation on the hot path of entering a coffee.
 *
 * Given that, the only question is which way the failure should fall, and the
 * answer is not symmetric:
 *
 * - **The ledger write is the primary fact.** It has already committed. The
 *   money moved, the derived balance is correct, and `/accounts`,
 *   `/dashboard` and `/transactions` all read live balances, not snapshots.
 * - **The snapshot is a derived trend.** One month of the net-worth chart is
 *   stale until the next balance-affecting write refreshes it — which the very
 *   next one will, since the writer recomputes the whole month from current
 *   state rather than applying a delta.
 *
 * Reporting the primary write as failed because a derived aggregate did not
 * refresh would be a lie that invites the person to enter the transaction
 * twice. So `refreshCurrentSnapshotAfter` swallows the failure, and every
 * mutation that calls it does so *after* its own write has already succeeded.
 *
 * ## What may be logged
 *
 * A sanitized operation noun and a classification code. Never an amount, a
 * balance, a merchant, a row, an account id, a raw PostgREST payload, or a
 * credential. The `AppError`'s own `message` is not logged either: it may name
 * a relation or an operation, and its `cause` carries the driver's response
 * verbatim. Only `error.code` — one of the seven fixed `AppErrorCode` labels —
 * is read, and an unrecognized throw becomes the literal `"unknown"`.
 */

/** The one RPC this module may call, named once. */
const REFRESH_RPC = "refresh_current_net_worth_snapshot";

/**
 * Recomputes the owner's snapshot for the month the owner is currently in.
 *
 * Throws on failure, like every other function in this layer — the
 * best-effort behavior lives in `refreshCurrentSnapshotAfter` below, so a
 * caller that genuinely needs to know whether the refresh worked can have that
 * answer, and the swallowing is visible at the call site rather than hidden in
 * here.
 *
 * Takes no owner and no month, because the function it calls takes neither:
 * the owner comes from the request's own JWT claim inside the database, and
 * the month is derived there from that owner's `profiles.timezone` — never
 * from server UTC. `getOwnerId()` is still called first, per this layer's
 * unconditional rule, so an ended session fails as `unauthorized` here rather
 * than as an opaque database refusal.
 */
export async function refreshCurrentNetWorthSnapshot(): Promise<void> {
  await getOwnerId();

  const supabase = await getDataClient();

  const { error } = await supabase.rpc(REFRESH_RPC);

  if (error) throw mapWriteError(error, "the net worth snapshot");
}

/**
 * The best-effort form, for use immediately after a mutation that has already
 * committed.
 *
 * Awaited rather than fired and forgotten: an un-awaited promise in a Server
 * Action can outlive the request, and a rejection from one is an unhandled
 * rejection rather than a log line. Awaiting also means that by the time the
 * action calls `revalidatePath`, the snapshot the re-render will read is
 * already current.
 *
 * `operation` is a short developer-authored noun for the write that preceded
 * this one ("a transaction", "the account") — never user input and never row
 * data, exactly as `mapWriteError`'s own operation argument is.
 */
export async function refreshCurrentSnapshotAfter(operation: string): Promise<void> {
  try {
    await refreshCurrentNetWorthSnapshot();
  } catch (error) {
    // Classification only. See "What may be logged" above.
    const code = isAppError(error) ? error.code : "unknown";
    console.error(
      `net-worth snapshot refresh failed after saving ${operation} [${code}]. ` +
        `The write itself succeeded; the current month's snapshot is stale until the next one.`
    );
  }
}

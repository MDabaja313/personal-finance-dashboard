import type { GoalContributionRow } from "@/components/goals/types";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";

/**
 * A goal's full contribution history — read-only, deliberately with no Edit
 * or Delete control anywhere in it. `goal_contributions` is append-only both
 * in the database and at every layer above it, so there is nothing this
 * component could offer that the server would actually do.
 *
 * Remains visible after the goal is archived: the caller passes the same
 * list either way, since archiving never touches a contribution row.
 */
export function ContributionHistory({
  contributions,
}: {
  contributions: readonly GoalContributionRow[];
}) {
  if (contributions.length === 0) {
    return <p className="text-sm text-muted-foreground">No contributions yet.</p>;
  }

  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {contributions.map((contribution) => (
        <li key={contribution.id} className="flex items-center justify-between gap-3 py-1.5">
          <div className="flex flex-col">
            <span>{formatCalendarDate(contribution.occurredOn)}</span>
            {contribution.note && (
              <span className="text-xs text-muted-foreground">{contribution.note}</span>
            )}
          </div>
          <span
            className={contribution.amountCents < 0 ? "text-destructive" : "text-foreground"}
          >
            {contribution.amountCents < 0 ? "" : "+"}
            {formatCents(contribution.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Translates the fixture oracle's slug ids (`"acc-checking"`,
 * `"cat-groceries"`, ...) into the deterministic UUIDs the seed actually
 * persisted them under (`uuidFor(slug)`, from `scripts/seed-identity.ts` —
 * the same function `scripts/generate-seed.ts` used to build
 * `supabase/seed.sql`).
 *
 * Every production ordering rule that includes an id as a tie-break
 * (`name ASC, id ASC`, `category_id ASC, id ASC`, ...) sorts on the
 * *persisted* UUID, not the fixture slug — a UUID has no lexicographic
 * relationship to the slug it replaced. So the oracle's output must be
 * translated into the UUID domain *before* any id-sensitive comparison, or
 * "row-for-row parity" would really be asserting two different sort orders
 * against each other and passing by accident on small fixtures only.
 *
 * Only `id` fields named here are translated — `period`/`month`/`kind`/etc.
 * are plain data, not ids, and pass through untouched.
 */
import { uuidFor } from "@/scripts/seed-identity";
import type { Account, Bill, Budget, Category, Goal, Transaction } from "@/lib/types";

export function translateAccount(account: Account): Account {
  return { ...account, id: uuidFor(account.id) };
}

export function translateCategory(category: Category): Category {
  return { ...category, id: uuidFor(category.id) };
}

export function translateBudget(budget: Budget): Budget {
  return { ...budget, id: uuidFor(budget.id), categoryId: uuidFor(budget.categoryId) };
}

export function translateGoal(goal: Goal): Goal {
  return { ...goal, id: uuidFor(goal.id) };
}

/**
 * Every id on a `Transaction`: its own, plus the account, category and
 * movement it points at. `categoryId`/`movementId` are legitimately absent
 * (an uncategorized ordinary row; any non-movement row) and must stay absent
 * — translating `undefined` through `uuidFor` would fabricate the UUID of the
 * string "undefined".
 */
export function translateTransaction(transaction: Transaction): Transaction {
  return {
    ...transaction,
    id: uuidFor(transaction.id),
    accountId: uuidFor(transaction.accountId),
    ...(transaction.categoryId === undefined ? {} : { categoryId: uuidFor(transaction.categoryId) }),
    ...(transaction.movementId === undefined ? {} : { movementId: uuidFor(transaction.movementId) }),
  };
}

/** Same rule for a `Bill`'s optional `categoryId`/`accountId`. */
export function translateBill(bill: Bill): Bill {
  return {
    ...bill,
    id: uuidFor(bill.id),
    ...(bill.categoryId === undefined ? {} : { categoryId: uuidFor(bill.categoryId) }),
    ...(bill.accountId === undefined ? {} : { accountId: uuidFor(bill.accountId) }),
  };
}

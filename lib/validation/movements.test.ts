import { describe, expect, it } from "vitest";

import { movementLegAmountsFor } from "@/lib/types/enums";
import {
  makeCreateMovementSchema,
  makeUpdateMovementSchema,
  movementDeleteSchema,
  zMovementKind,
} from "@/lib/validation/movements";
import { makeCreateTransactionSchema } from "@/lib/validation/transactions";

/**
 * The movement schemas, offline.
 *
 * Every rule here is applied again by the database — `public.create_movement`
 * re-checks the magnitude, the two-different-accounts rule and the card-payment
 * destination in SQL; `assert_transaction_refs()` re-checks the posted date and
 * the archived account; `validate_movement()` re-checks the pair at COMMIT. So
 * what this suite is actually asserting is that a person gets a *field* to
 * attach the message to, before any query is issued, and that the field is the
 * right one.
 */

const TODAY = "2026-08-28";
const TOMORROW = "2026-08-29";

const MOVEMENT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_LEG_ID = "00000000-0000-4000-8000-000000000002";
const DESTINATION_LEG_ID = "00000000-0000-4000-8000-000000000003";
const CHECKING = "00000000-0000-4000-8000-0000000000a1";
const SAVINGS = "00000000-0000-4000-8000-0000000000a2";

/** A complete, valid submission — every case below is this with one field changed. */
function submission(overrides: Record<string, string> = {}) {
  return {
    id: MOVEMENT_ID,
    sourceLegId: SOURCE_LEG_ID,
    destinationLegId: DESTINATION_LEG_ID,
    kind: "transfer",
    date: "2026-08-20",
    fromAccountId: CHECKING,
    toAccountId: SAVINGS,
    amount: "250.00",
    ...overrides,
  };
}

/** The field names a failed parse attached its messages to. */
function fieldsWithErrors(result: { success: boolean; error?: unknown }): string[] {
  if (result.success) return [];
  const issues = (result.error as { issues: { path: (string | number)[] }[] }).issues;
  return [...new Set(issues.map((issue) => String(issue.path[0])))].sort();
}

describe("zMovementKind", () => {
  it("accepts exactly the two paired kinds", () => {
    expect(zMovementKind.safeParse("transfer").success).toBe(true);
    expect(zMovementKind.safeParse("credit_card_payment").success).toBe(true);
  });

  it("refuses every ordinary kind, and adjustment", () => {
    // Not "this is not a movement kind, here are the ones that are": the
    // control only ever offers two options, so a third arriving means a
    // hand-crafted request.
    for (const kind of ["income", "expense", "refund", "adjustment", "", "TRANSFER"]) {
      const result = zMovementKind.safeParse(kind);
      expect(result.success, `${kind} must not parse as a movement kind`).toBe(false);
    }
  });
});

describe("makeCreateMovementSchema — the happy path", () => {
  it("produces the domain input, with the magnitude and both leg ids intact", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(submission());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: MOVEMENT_ID,
      sourceLegId: SOURCE_LEG_ID,
      destinationLegId: DESTINATION_LEG_ID,
      kind: "transfer",
      date: "2026-08-20",
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      // A positive magnitude — never a signed leg amount.
      amountCents: 25_000,
    });
  });

  it("accepts a credit card payment", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(
      submission({ kind: "credit_card_payment" })
    );

    expect(result.success).toBe(true);
    expect(result.data?.kind).toBe("credit_card_payment");
  });

  it("accepts today itself", () => {
    expect(makeCreateMovementSchema(TODAY).safeParse(submission({ date: TODAY })).success).toBe(
      true
    );
  });

  it("carries no merchant and no category — there are no such fields", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(
      // Posted anyway, as a hand-crafted request would. They are not in the
      // schema's shape, so they are dropped rather than stored.
      submission({ merchant: "Laundering", categoryId: CHECKING })
    );

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("merchant");
    expect(result.data).not.toHaveProperty("categoryId");
  });
});

describe("makeCreateMovementSchema — the amount is a strictly positive magnitude", () => {
  it("refuses zero, under `amount`", () => {
    // Legal for an ordinary transaction (a waived fee), illegal for a movement
    // leg — `transactions_movement_nonzero_ck`. A transfer of nothing is not an
    // event.
    const result = makeCreateMovementSchema(TODAY).safeParse(submission({ amount: "0" }));

    expect(result.success).toBe(false);
    expect(fieldsWithErrors(result)).toEqual(["amount"]);
  });

  it("refuses zero however it is spelled", () => {
    for (const amount of ["0", "0.00", "$0.00", "0,000.00"]) {
      expect(
        makeCreateMovementSchema(TODAY).safeParse(submission({ amount })).success,
        `${amount} must be refused`
      ).toBe(false);
    }
  });

  it("refuses a negative amount — there is no sign to submit", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(submission({ amount: "-50.00" }));

    expect(result.success).toBe(false);
    expect(fieldsWithErrors(result)).toEqual(["amount"]);
  });

  it("refuses a malformed amount without constructing a float", () => {
    for (const amount of ["1e5", "abc", "12.345", ""]) {
      expect(
        makeCreateMovementSchema(TODAY).safeParse(submission({ amount })).success,
        `${amount} must be refused`
      ).toBe(false);
    }
  });
});

describe("makeCreateMovementSchema — cross-field rules", () => {
  it("refuses the same account twice, under `toAccountId`", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(
      submission({ toAccountId: CHECKING })
    );

    expect(result.success).toBe(false);
    // Attached to the destination picker, which is the one they most likely
    // just changed — not to the form as a whole, which would leave a person
    // hunting for which control is wrong.
    expect(fieldsWithErrors(result)).toEqual(["toAccountId"]);
  });

  it("refuses two legs sharing an id", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(
      submission({ destinationLegId: SOURCE_LEG_ID })
    );

    expect(result.success).toBe(false);
    expect(fieldsWithErrors(result)).toEqual(["id"]);
  });

  it("refuses a leg id that collides with the movement id", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(
      submission({ sourceLegId: MOVEMENT_ID })
    );

    expect(result.success).toBe(false);
    expect(fieldsWithErrors(result)).toEqual(["id"]);
  });

  it("refuses the owner's tomorrow, under `date`", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(submission({ date: TOMORROW }));

    expect(result.success).toBe(false);
    expect(fieldsWithErrors(result)).toEqual(["date"]);
  });

  it("takes `today` as a parameter rather than reading a clock", () => {
    // The same date is refused against one ceiling and accepted against a
    // later one, which is only possible because the bound is supplied.
    expect(makeCreateMovementSchema("2026-08-19").safeParse(submission()).success).toBe(false);
    expect(makeCreateMovementSchema("2026-08-20").safeParse(submission()).success).toBe(true);
  });

  it("refuses a malformed id, a malformed leg id, and a malformed account id", () => {
    for (const field of ["id", "sourceLegId", "destinationLegId", "fromAccountId", "toAccountId"]) {
      const result = makeCreateMovementSchema(TODAY).safeParse(submission({ [field]: "nope" }));
      expect(result.success, `${field} must be a UUID`).toBe(false);
      expect(fieldsWithErrors(result)).toContain(field);
    }
  });

  it("accepts no owner id — there is no such field to supply", () => {
    const result = makeCreateMovementSchema(TODAY).safeParse(
      submission({ userId: "00000000-0000-4000-8000-00000000dead" })
    );

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("userId");
  });
});

describe("makeUpdateMovementSchema", () => {
  it("takes the same shape, so an edit resubmits every value whole", () => {
    const result = makeUpdateMovementSchema(TODAY).safeParse(submission());

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(MOVEMENT_ID);
    // The existing legs' ids come back in, so an edit preserves each leg's row
    // identity rather than minting a new id for a row that already existed.
    expect(result.data?.sourceLegId).toBe(SOURCE_LEG_ID);
    expect(result.data?.destinationLegId).toBe(DESTINATION_LEG_ID);
  });

  it("applies every one of the create rules", () => {
    expect(makeUpdateMovementSchema(TODAY).safeParse(submission({ amount: "0" })).success).toBe(
      false
    );
    expect(
      makeUpdateMovementSchema(TODAY).safeParse(submission({ toAccountId: CHECKING })).success
    ).toBe(false);
    expect(makeUpdateMovementSchema(TODAY).safeParse(submission({ date: TOMORROW })).success).toBe(
      false
    );
    expect(makeUpdateMovementSchema(TODAY).safeParse(submission({ kind: "expense" })).success).toBe(
      false
    );
  });
});

describe("movementDeleteSchema", () => {
  it("takes the movement id and nothing else", () => {
    const result = movementDeleteSchema.safeParse({ id: MOVEMENT_ID });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: MOVEMENT_ID });
  });

  it("refuses a malformed id", () => {
    expect(movementDeleteSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});

describe("sign derivation — movementLegAmountsFor", () => {
  it("debits the source and credits the destination, summing to zero", () => {
    const legs = movementLegAmountsFor(25_000 as never);

    expect(legs.sourceCents).toBe(-25_000);
    expect(legs.destinationCents).toBe(25_000);
    expect(legs.sourceCents + legs.destinationCents).toBe(0);
  });

  it("throws rather than coercing a non-positive magnitude", () => {
    // Validation has already refused both with a message a person can act on.
    // Silently flipping one here would mean a value that bypassed validation
    // still produced a plausible-looking pair.
    expect(() => movementLegAmountsFor(0 as never)).toThrow();
    expect(() => movementLegAmountsFor(-1 as never)).toThrow();
  });

  it("mirrors what the validated magnitude would become", () => {
    const parsed = makeCreateMovementSchema(TODAY).safeParse(submission({ amount: "1,234.56" }));
    expect(parsed.success).toBe(true);

    const legs = movementLegAmountsFor(parsed.data!.amountCents);
    expect(legs.sourceCents).toBe(-123_456);
    expect(legs.destinationCents).toBe(123_456);
  });
});

describe("the ordinary transaction schema still refuses movement kinds", () => {
  // The other half of the two-schema split. If this ever passes, the ordinary
  // surface has become a path to writing half a movement.
  it("refuses transfer and credit_card_payment", () => {
    for (const kind of ["transfer", "credit_card_payment", "adjustment"]) {
      const result = makeCreateTransactionSchema(TODAY).safeParse({
        id: MOVEMENT_ID,
        accountId: CHECKING,
        date: "2026-08-20",
        merchant: "Sneaky",
        kind,
        categoryId: "",
        amount: "10.00",
      });

      expect(result.success, `the ordinary form must refuse ${kind}`).toBe(false);
      expect(fieldsWithErrors(result)).toContain("kind");
    }
  });
});

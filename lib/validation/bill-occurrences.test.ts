import { describe, expect, it } from "vitest";

import {
  billOccurrenceRestoreSchema,
  billOccurrenceSkipSchema,
  makeBillOccurrencePaidSchema,
} from "@/lib/validation/bill-occurrences";

const OCCURRENCE_ID = "00000000-0000-4000-8000-000000000001";
const TRANSACTION_ID = "00000000-0000-4000-8000-0000000000t1".replace("t", "0");
/** The key a generated payment would take. Required on every submission — see the schema. */
const GENERATED_ID = "00000000-0000-4000-8000-000000000099";

/** A fixed owner "today" — this layer never reads a clock. */
const TODAY = "2026-08-29";

/** The two fields every valid mark-paid submission carries, so each case states only its own. */
const base = { id: OCCURRENCE_ID, generatedTransactionId: GENERATED_ID };

describe("makeBillOccurrencePaidSchema", () => {
  const schema = makeBillOccurrencePaidSchema(TODAY);

  it("parses an occurrence id, a paid date, an optional link, and the generated-payment key", () => {
    expect(
      schema.parse({ ...base, paidOn: "2026-08-27", transactionId: TRANSACTION_ID })
    ).toEqual({
      id: OCCURRENCE_ID,
      paidOn: "2026-08-27",
      transactionId: TRANSACTION_ID,
      generatedTransactionId: GENERATED_ID,
    });
  });

  it("leaves the transaction link undefined when nothing was selected", () => {
    const parsed = schema.parse({ ...base, paidOn: TODAY, transactionId: "" });
    expect(parsed.transactionId).toBeUndefined();
  });

  it("requires the generated-payment key even when a transaction is linked", () => {
    // Whether the server ends up generating a row depends on the bill's account
    // and on whether it is archived — facts the browser does not have. So the
    // key is unconditional rather than conditional on a prediction the form
    // cannot make. Phase 8 CP1.
    expect(
      schema.safeParse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: TRANSACTION_ID }).success
    ).toBe(false);
    expect(schema.safeParse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: "" }).success).toBe(
      false
    );
  });

  it("rejects a malformed generated-payment key rather than silently dropping it", () => {
    expect(
      schema.safeParse({ ...base, generatedTransactionId: "not-a-uuid", paidOn: TODAY }).success
    ).toBe(false);
  });

  it("accepts the owner's own today", () => {
    expect(schema.parse({ ...base, paidOn: TODAY, transactionId: "" }).paidOn).toBe(TODAY);
  });

  it("rejects a paid date in the owner's future", () => {
    expect(schema.safeParse({ ...base, paidOn: "2026-08-30", transactionId: "" }).success).toBe(
      false
    );
  });

  it("uses the supplied today, not a clock — a different owner day moves the ceiling", () => {
    // The same date is accepted against one owner day and refused against the
    // day before it. That is the whole reason this is a factory: an owner in
    // Auckland and an owner in Los Angeles are on different calendar days at
    // the same instant, and the ceiling has to follow the person. It is also
    // the date a generated expense takes, so `assert_transaction_refs()`'s own
    // ceiling and this one are the same rule read twice.
    const earlier = makeBillOccurrencePaidSchema("2026-08-28");
    expect(earlier.safeParse({ ...base, paidOn: TODAY, transactionId: "" }).success).toBe(false);
    expect(schema.safeParse({ ...base, paidOn: TODAY, transactionId: "" }).success).toBe(true);
  });

  it("accepts a paid date long before the due date and long after it — no floor exists", () => {
    for (const paidOn of ["2020-01-01", "2026-08-01", TODAY]) {
      expect(schema.safeParse({ ...base, paidOn, transactionId: "" }).success).toBe(true);
    }
  });

  it("rejects a paid date that does not exist on the calendar", () => {
    expect(schema.safeParse({ ...base, paidOn: "2026-02-30", transactionId: "" }).success).toBe(
      false
    );
  });

  it("requires a paid date", () => {
    expect(schema.safeParse({ ...base, paidOn: "", transactionId: "" }).success).toBe(false);
  });

  it("rejects a malformed transaction id rather than silently dropping it", () => {
    expect(
      schema.safeParse({ ...base, paidOn: TODAY, transactionId: "not-a-uuid" }).success
    ).toBe(false);
  });

  it("accepts no status field — the action names the transition, not the caller", () => {
    const parsed = schema.parse({
      ...base,
      paidOn: TODAY,
      transactionId: "",
      status: "skipped",
    });
    expect(parsed).not.toHaveProperty("status");
  });

  it("accepts no amount, due date, account or category — none of them is a settlement input", () => {
    // The generated expense's amount comes from the *occurrence*, its account
    // and category from the *bill*, and its date from `paidOn`. Nothing about
    // the ledger row is a field a caller may supply, which is what keeps a
    // hand-crafted request from posting an expense of its choosing through the
    // bill surface.
    const parsed = schema.parse({
      ...base,
      paidOn: TODAY,
      transactionId: "",
      amount: "999",
      dueDate: "2030-01-01",
      accountId: TRANSACTION_ID,
      categoryId: TRANSACTION_ID,
      merchant: "anything",
      kind: "income",
    });
    expect(parsed).not.toHaveProperty("amount");
    expect(parsed).not.toHaveProperty("amountCents");
    expect(parsed).not.toHaveProperty("dueDate");
    expect(parsed).not.toHaveProperty("accountId");
    expect(parsed).not.toHaveProperty("categoryId");
    expect(parsed).not.toHaveProperty("merchant");
    expect(parsed).not.toHaveProperty("kind");
  });

  it("throws on a malformed `today` rather than comparing against garbage", () => {
    expect(() => makeBillOccurrencePaidSchema("not-a-date")).toThrow();
  });
});

describe("billOccurrenceSkipSchema", () => {
  it("takes an occurrence id and nothing else", () => {
    expect(billOccurrenceSkipSchema.parse({ id: OCCURRENCE_ID })).toEqual({ id: OCCURRENCE_ID });
  });

  it("drops anything else posted alongside it", () => {
    const parsed = billOccurrenceSkipSchema.parse({
      id: OCCURRENCE_ID,
      status: "paid",
      paidOn: TODAY,
      transactionId: TRANSACTION_ID,
      generatedTransactionId: GENERATED_ID,
    });
    expect(parsed).toEqual({ id: OCCURRENCE_ID });
  });

  it("rejects a malformed id", () => {
    expect(billOccurrenceSkipSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});

describe("billOccurrenceRestoreSchema", () => {
  it("takes an occurrence id and nothing else — one transition, two labels", () => {
    expect(billOccurrenceRestoreSchema.parse({ id: OCCURRENCE_ID })).toEqual({ id: OCCURRENCE_ID });
  });

  it("carries no field that could ask for a transaction to be deleted", () => {
    // Unmarking may remove a generated payment, and *that* decision is read
    // from the occurrence's stored `transaction_origin` inside
    // `public.unsettle_bill_occurrence` — never from the submission. There is
    // no field here for a caller to set, which is the first of the two layers
    // making "a manually linked transaction is never deleted" true.
    const parsed = billOccurrenceRestoreSchema.parse({
      id: OCCURRENCE_ID,
      transactionId: TRANSACTION_ID,
      transactionOrigin: "generated",
      deleteTransaction: "true",
    });
    expect(parsed).toEqual({ id: OCCURRENCE_ID });
  });

  it("rejects a malformed id", () => {
    expect(billOccurrenceRestoreSchema.safeParse({ id: "" }).success).toBe(false);
  });
});

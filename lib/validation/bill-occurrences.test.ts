import { describe, expect, it } from "vitest";

import {
  billOccurrenceRestoreSchema,
  billOccurrenceSkipSchema,
  makeBillOccurrencePaidSchema,
} from "@/lib/validation/bill-occurrences";

const OCCURRENCE_ID = "00000000-0000-4000-8000-000000000001";
const TRANSACTION_ID = "00000000-0000-4000-8000-0000000000t1".replace("t", "0");

/** A fixed owner "today" — this layer never reads a clock. */
const TODAY = "2026-08-29";

describe("makeBillOccurrencePaidSchema", () => {
  const schema = makeBillOccurrencePaidSchema(TODAY);

  it("parses an occurrence id, a paid date, and an optional transaction link", () => {
    expect(
      schema.parse({ id: OCCURRENCE_ID, paidOn: "2026-08-27", transactionId: TRANSACTION_ID })
    ).toEqual({
      id: OCCURRENCE_ID,
      paidOn: "2026-08-27",
      transactionId: TRANSACTION_ID,
    });
  });

  it("leaves the transaction link undefined when nothing was selected", () => {
    const parsed = schema.parse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: "" });
    expect(parsed.transactionId).toBeUndefined();
  });

  it("accepts the owner's own today", () => {
    expect(schema.parse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: "" }).paidOn).toBe(TODAY);
  });

  it("rejects a paid date in the owner's future", () => {
    expect(
      schema.safeParse({ id: OCCURRENCE_ID, paidOn: "2026-08-30", transactionId: "" }).success
    ).toBe(false);
  });

  it("uses the supplied today, not a clock — a different owner day moves the ceiling", () => {
    // The same date is accepted against one owner day and refused against the
    // day before it. That is the whole reason this is a factory: an owner in
    // Auckland and an owner in Los Angeles are on different calendar days at
    // the same instant, and the ceiling has to follow the person.
    const earlier = makeBillOccurrencePaidSchema("2026-08-28");
    expect(earlier.safeParse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: "" }).success).toBe(
      false
    );
    expect(schema.safeParse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: "" }).success).toBe(
      true
    );
  });

  it("accepts a paid date long before the due date and long after it — no floor exists", () => {
    for (const paidOn of ["2020-01-01", "2026-08-01", TODAY]) {
      expect(schema.safeParse({ id: OCCURRENCE_ID, paidOn, transactionId: "" }).success).toBe(true);
    }
  });

  it("rejects a paid date that does not exist on the calendar", () => {
    expect(
      schema.safeParse({ id: OCCURRENCE_ID, paidOn: "2026-02-30", transactionId: "" }).success
    ).toBe(false);
  });

  it("requires a paid date", () => {
    expect(schema.safeParse({ id: OCCURRENCE_ID, paidOn: "", transactionId: "" }).success).toBe(
      false
    );
  });

  it("rejects a malformed transaction id rather than silently dropping it", () => {
    expect(
      schema.safeParse({ id: OCCURRENCE_ID, paidOn: TODAY, transactionId: "not-a-uuid" }).success
    ).toBe(false);
  });

  it("accepts no status field — the action names the transition, not the caller", () => {
    const parsed = schema.parse({
      id: OCCURRENCE_ID,
      paidOn: TODAY,
      transactionId: "",
      status: "skipped",
    });
    expect(parsed).not.toHaveProperty("status");
  });

  it("accepts no amount or due date — neither is editable on an occurrence", () => {
    const parsed = schema.parse({
      id: OCCURRENCE_ID,
      paidOn: TODAY,
      transactionId: "",
      amount: "999",
      dueDate: "2030-01-01",
    });
    expect(parsed).not.toHaveProperty("amount");
    expect(parsed).not.toHaveProperty("amountCents");
    expect(parsed).not.toHaveProperty("dueDate");
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

  it("rejects a malformed id", () => {
    expect(billOccurrenceRestoreSchema.safeParse({ id: "" }).success).toBe(false);
  });
});

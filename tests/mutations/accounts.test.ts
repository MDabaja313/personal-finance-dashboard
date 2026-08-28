import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { ACCOUNT_ROUTES, IDLE, formData } from "./support/mutation-harness";

/**
 * Account writes, end to end: real Server Actions → real validation → real
 * mutation DAL → real local Supabase (RLS on, ordinary `authenticated` JWT) →
 * read back through the real production read DAL.
 *
 * ## The three things this proves that nothing else can
 *
 * `npm test` proves the schemas in isolation. `npm run db:test` proves the
 * grants, the policies and the triggers in isolation. Neither proves they are
 * *wired together* — that the action posts the columns the grant allows, that
 * the DAL's preflight and the database's trigger agree about what is refused,
 * or that a write is visible to the read path afterwards. That is this suite's
 * whole job, and it is why the only thing mocked is the Supabase seam plus the
 * two Next.js request-scoped functions.
 *
 * Each test creates its own accounts under distinctive names rather than
 * reusing the seed, so the file's tests do not depend on each other's order
 * beyond what they state explicitly. The seeded accounts are used only where
 * "an account that already has transactions" is the point.
 */

const mocks = vi.hoisted(() => ({
  client: undefined as unknown,
  ownerId: "" as string,
  revalidated: [] as string[],
  redirectedTo: null as string | null,
}));

// The one seam lib/data/** uses to reach the database. Everything downstream of
// it — mappers, query builders, preflights, error mapping — is real.
vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

// Request-scoped Next.js functions, recorded rather than no-oped.
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    mocks.revalidated.push(path);
  },
}));

vi.mock("next/navigation", () => ({
  // The real redirect() signals by throwing, so this one must too: an action
  // that redirects must not fall through to the code after it.
  redirect: (path: string) => {
    mocks.redirectedTo = path;
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

const actions = await import("@/lib/actions/accounts");
const mutations = await import("@/lib/data/mutations/accounts");
const { getAccounts } = await import("@/lib/data/accounts");

let context: Awaited<ReturnType<typeof createMutationContext>>;

beforeAll(async () => {
  context = await createMutationContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
}, 30_000);

beforeEach(() => {
  mocks.revalidated = [];
  mocks.redirectedTo = null;
});

/** The account with this exact name, read back through the production DAL. */
async function readAccount(name: string) {
  return (await getAccounts()).find((account) => account.name === name);
}

/** A seeded account that already has transactions — the "has history" fixture. */
async function seededAccountWithHistory() {
  const account = await readAccount("Everyday Checking");
  expect(account, "the seed should provide 'Everyday Checking'").toBeDefined();
  return account!;
}

describe("createAccountAction", () => {
  it("creates an account and makes it visible through the production read DAL", async () => {
    const state = await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Created Checking",
        institution: "Test Bank",
        type: "checking",
        openingBalance: "1,234.56",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();

    const created = await readAccount("CP2 Created Checking");
    expect(created).toBeDefined();
    expect(created!.institution).toBe("Test Bank");
    expect(created!.type).toBe("checking");
    // No transactions yet, so the derived balance is the opening figure.
    expect(created!.balanceCents).toBe(123456);
    expect(created!.isArchived).toBe(false);
  });

  it("stores the credit-only columns and the signed opening balance convention", async () => {
    const state = await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Created Card",
        institution: "Test Card Co.",
        type: "credit",
        // Liabilities are stored negative — the existing convention, not a new
        // one. See lib/validation/accounts.ts.
        openingBalance: "-1284.50",
        creditLimit: "5000",
        // A percentage in, basis points stored: 23.99% is 2399bp, and via a
        // float 23.99 * 100 would be 2398.9999999999995.
        interestRate: "23.99",
      })
    );

    expect(state.status).toBe("success");

    const created = await readAccount("CP2 Created Card");
    expect(created).toBeDefined();
    expect(created!.balanceCents).toBe(-128450);
    expect(created!.creditLimitCents).toBe(500000);
    expect(created!.interestRateBps).toBe(2399);
  });

  it("revalidates exactly the three account routes on success", async () => {
    await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Revalidation Probe",
        institution: "Test Bank",
        type: "cash",
        openingBalance: "0",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(mocks.revalidated).toEqual(ACCOUNT_ROUTES);
    expect(mocks.redirectedTo).toBeNull();
  });

  it("returns field errors and writes nothing when validation fails", async () => {
    const state = await actions.createAccountAction(
      IDLE,
      formData({
        name: "   ",
        institution: "Test Bank",
        type: "checking",
        openingBalance: "not money",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.name).toBeDefined();
    expect(state.fieldErrors.openingBalance).toBeDefined();
    // Nothing was revalidated, because nothing was written.
    expect(mocks.revalidated).toEqual([]);
    // The submitted text comes back so the form is not blanked...
    expect(state.values?.institution).toBe("Test Bank");
    // ...and nothing else does. No id, no row, no derived figure.
    expect(Object.keys(state)).toEqual(["status", "formError", "fieldErrors", "values"]);
  });

  it("rejects a credit limit on an account type that cannot carry one", async () => {
    const state = await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Never Created",
        institution: "Test Bank",
        type: "checking",
        openingBalance: "10",
        creditLimit: "5000",
        interestRate: "",
      })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.creditLimit).toBeDefined();
    expect(await readAccount("CP2 Never Created")).toBeUndefined();
  });
});

describe("updateAccountAction", () => {
  it("edits the allowed metadata and leaves the opening balance alone when blank", async () => {
    await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Editable",
        institution: "Old Bank",
        type: "savings",
        openingBalance: "500.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    const before = await readAccount("CP2 Editable");
    expect(before).toBeDefined();
    // The setup create above revalidated too; only the edit's own calls matter.
    mocks.revalidated = [];

    const state = await actions.updateAccountAction(
      IDLE,
      formData({
        id: before!.id,
        name: "CP2 Edited",
        institution: "New Bank",
        openingBalance: "",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(ACCOUNT_ROUTES);

    const after = await readAccount("CP2 Edited");
    expect(after).toBeDefined();
    expect(after!.id).toBe(before!.id);
    expect(after!.institution).toBe("New Bank");
    // Blank means "unchanged", never zero.
    expect(after!.balanceCents).toBe(50000);
  });

  it("changes the opening balance while the account has no transactions", async () => {
    await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Opening Editable",
        institution: "Test Bank",
        type: "savings",
        openingBalance: "100.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    const before = await readAccount("CP2 Opening Editable");

    const state = await actions.updateAccountAction(
      IDLE,
      formData({
        id: before!.id,
        name: "CP2 Opening Editable",
        institution: "Test Bank",
        openingBalance: "250.75",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("success");
    expect((await readAccount("CP2 Opening Editable"))!.balanceCents).toBe(25075);
  });

  it("refuses to change the opening balance once the account has transactions", async () => {
    const account = await seededAccountWithHistory();
    const balanceBefore = account.balanceCents;

    const state = await actions.updateAccountAction(
      IDLE,
      formData({
        id: account.id,
        name: account.name,
        institution: account.institution,
        openingBalance: "999999.99",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe(
      "The opening balance cannot change once the account has transactions."
    );
    expect(mocks.revalidated).toEqual([]);
    expect((await readAccount(account.name))!.balanceCents).toBe(balanceBefore);
  });

  it("reports a clean not-found for an id the owner does not have", async () => {
    // A well-formed uuid that names no owned row. RLS makes "someone else's
    // account" and "no such account" indistinguishable, which is the intent.
    const state = await actions.updateAccountAction(
      IDLE,
      formData({
        id: "00000000-0000-4000-8000-000000000000",
        name: "Whatever",
        institution: "Whatever",
        openingBalance: "",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });
});

describe("setAccountArchivedAction", () => {
  it("archives an account whose derived balance is zero, and unarchives it again", async () => {
    await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Archivable",
        institution: "Test Bank",
        type: "cash",
        openingBalance: "0",
        creditLimit: "",
        interestRate: "",
      })
    );
    const account = await readAccount("CP2 Archivable");
    expect(account!.isArchived).toBe(false);
    mocks.revalidated = [];

    const archived = await actions.setAccountArchivedAction(
      IDLE,
      formData({ id: account!.id, archived: "true" })
    );

    expect(archived.status).toBe("success");
    expect(mocks.revalidated).toEqual(ACCOUNT_ROUTES);
    expect((await readAccount("CP2 Archivable"))!.isArchived).toBe(true);

    mocks.revalidated = [];
    const unarchived = await actions.setAccountArchivedAction(
      IDLE,
      formData({ id: account!.id, archived: "false" })
    );

    expect(unarchived.status).toBe("success");
    expect((await readAccount("CP2 Archivable"))!.isArchived).toBe(false);
  });

  it("refuses to archive an account that still holds money", async () => {
    await actions.createAccountAction(
      IDLE,
      formData({
        name: "CP2 Not Archivable",
        institution: "Test Bank",
        type: "savings",
        openingBalance: "42.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    const account = await readAccount("CP2 Not Archivable");
    mocks.revalidated = [];

    const state = await actions.setAccountArchivedAction(
      IDLE,
      formData({ id: account!.id, archived: "true" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("An account can only be archived once its balance is zero.");
    expect(mocks.revalidated).toEqual([]);
    expect((await readAccount("CP2 Not Archivable"))!.isArchived).toBe(false);
  });

  it("refuses to archive a seeded account whose ledger leaves a nonzero balance", async () => {
    // The interesting case: opening balance and transactions both nonzero, so
    // the rule can only pass or fail on the *derived* figure.
    const account = await seededAccountWithHistory();
    expect(account.balanceCents).not.toBe(0);

    const state = await actions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "true" })
    );

    expect(state.status).toBe("error");
    expect((await readAccount(account.name))!.isArchived).toBe(false);
  });
});

describe("privileges the application never uses are unreachable from the owner's own client", () => {
  // These bypass the DAL entirely and issue the request a compromised browser
  // session could issue directly against PostgREST with the owner's real token.
  // If the column grants were wrong, nothing in the layers above would notice.

  it("cannot change an account's type", async () => {
    const account = await seededAccountWithHistory();

    const { error } = await context.client
      .from("accounts")
      .update({ type: "savings" })
      .eq("id", account.id);

    expect(error).not.toBeNull();
    // 42501 — insufficient_privilege. The GRANT layer refuses before RLS, the
    // trigger, or any row is consulted.
    expect(error!.code).toBe("42501");
    expect((await readAccount(account.name))!.type).toBe(account.type);
  });

  it("cannot reassign an account to another owner", async () => {
    const account = await seededAccountWithHistory();

    const { error } = await context.client
      .from("accounts")
      .update({ user_id: "00000000-0000-4000-8000-000000000000" })
      .eq("id", account.id);

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("cannot delete an account", async () => {
    const account = await readAccount("CP2 Revalidation Probe");

    const { error } = await context.client.from("accounts").delete().eq("id", account!.id);

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(await readAccount("CP2 Revalidation Probe")).toBeDefined();
  });

  it("cannot create an account owned by someone else", async () => {
    const { error } = await context.client.from("accounts").insert({
      user_id: "00000000-0000-4000-8000-000000000000",
      name: "CP2 Foreign",
      institution: "Test Bank",
      type: "checking",
      opening_balance_cents: 0,
    });

    expect(error).not.toBeNull();
    // The row-level security policy's WITH CHECK refuses a row the owner would
    // not be allowed to see, which PostgreSQL also reports as 42501.
    expect(error!.code).toBe("42501");
    expect(await readAccount("CP2 Foreign")).toBeUndefined();
  });
});

describe("the mutation DAL's own contract", () => {
  it("never takes an owner id from its caller", async () => {
    // Stated as a type-level fact by the signatures, and as a runtime one here:
    // createAccount takes only the validated form input, and the row it writes
    // belongs to the verified owner regardless.
    const id = await mutations.createAccount({
      name: "CP2 DAL Direct",
      institution: "Test Bank",
      type: "checking",
      openingBalanceCents: 0 as never,
    });

    const { data } = await context.client.from("accounts").select("user_id").eq("id", id).single();
    expect((data as { user_id: string }).user_id).toBe(context.ownerId);
  });

  it("throws not_found rather than silently doing nothing for an unowned id", async () => {
    await expect(
      mutations.setAccountArchived("00000000-0000-4000-8000-000000000000", true)
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

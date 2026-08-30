import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { CATEGORY_ROUTES, IDLE, formData } from "./support/mutation-harness";

/**
 * Category writes, end to end — same arrangement as `accounts.test.ts`: real
 * Server Actions, real validation, real mutation DAL, real local Supabase with
 * RLS on, read back through the real production read DAL.
 *
 * The kind rule is the centre of this file. `kind` is in the CP2 UPDATE grant,
 * so a browser session can reach it directly; the only thing standing between
 * that and a silent reclassification of months of settled figures is
 * `guard_category_kind_change()`, plus the mutation layer's preflight in front
 * of it for the message. The seed supplies exactly the fixtures needed to prove
 * it in both directions: a fresh category referenced by nothing, and seeded
 * categories referenced by a transaction, by a budget, and by a bill.
 */

const mocks = vi.hoisted(() => ({
  client: undefined as unknown,
  ownerId: "" as string,
  revalidated: [] as string[],
  redirectedTo: null as string | null,
}));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    mocks.revalidated.push(path);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    mocks.redirectedTo = path;
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

const actions = await import("@/lib/actions/categories");
const { getCategories } = await import("@/lib/data/categories");

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

/** The category with this exact name, read back through the production DAL. */
async function readCategory(name: string) {
  return (await getCategories()).find((category) => category.name === name);
}

/** Creates a category through the real action and returns the stored row. */
async function createCategory(name: string, kind: "income" | "expense") {
  const state = await actions.createCategoryAction(IDLE, formData({ name, kind }));
  expect(state.status, state.formError ?? "").toBe("success");
  const created = await readCategory(name);
  expect(created).toBeDefined();
  return created!;
}

describe("createCategoryAction", () => {
  it("creates a category and makes it visible through the production read DAL", async () => {
    const state = await actions.createCategoryAction(
      IDLE,
      formData({ name: "  CP2 Coffee  ", kind: "expense" })
    );

    expect(state.status).toBe("success");

    const created = await readCategory("CP2 Coffee");
    expect(created).toBeDefined();
    expect(created!.kind).toBe("expense");
    // The DTO now carries archive state — the CP2 read-side change.
    expect(created!.isArchived).toBe(false);
  });

  it("revalidates exactly the four category routes on success", async () => {
    await actions.createCategoryAction(IDLE, formData({ name: "CP2 Probe", kind: "income" }));

    expect(mocks.revalidated).toEqual(CATEGORY_ROUTES);
    expect(mocks.redirectedTo).toBeNull();
  });

  it("reports a duplicate name specifically, case-insensitively", async () => {
    // The unique index is on (user_id, lower(name)), so this collides with the
    // seeded "Groceries" despite the different casing.
    const state = await actions.createCategoryAction(
      IDLE,
      formData({ name: "gRoCeRiEs", kind: "expense" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("You already have a category with that name.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("returns a field error and writes nothing for a blank name", async () => {
    const before = (await getCategories()).length;

    const state = await actions.createCategoryAction(IDLE, formData({ name: "   ", kind: "expense" }));

    expect(state.status).toBe("error");
    expect(state.fieldErrors.name).toBeDefined();
    expect(mocks.revalidated).toEqual([]);
    expect((await getCategories()).length).toBe(before);
  });
});

describe("updateCategoryAction", () => {
  it("renames a category", async () => {
    const created = await createCategory("CP2 Rename Me", "expense");
    mocks.revalidated = [];

    const state = await actions.updateCategoryAction(
      IDLE,
      formData({ id: created.id, name: "CP2 Renamed", kind: "expense" })
    );

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(CATEGORY_ROUTES);

    const renamed = await readCategory("CP2 Renamed");
    expect(renamed).toBeDefined();
    expect(renamed!.id).toBe(created.id);
    expect(await readCategory("CP2 Rename Me")).toBeUndefined();
  });

  it("changes the kind while the category is referenced by nothing", async () => {
    const created = await createCategory("CP2 Retypeable", "expense");

    const state = await actions.updateCategoryAction(
      IDLE,
      formData({ id: created.id, name: "CP2 Retypeable", kind: "income" })
    );

    expect(state.status).toBe("success");
    expect((await readCategory("CP2 Retypeable"))!.kind).toBe("income");
  });

  it("refuses to change the kind of a category referenced by a transaction", async () => {
    const groceries = await readCategory("Groceries");
    expect(groceries!.kind).toBe("expense");

    const state = await actions.updateCategoryAction(
      IDLE,
      formData({ id: groceries!.id, name: "Groceries", kind: "income" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe(
      "This category is already in use, so its type can no longer be changed."
    );
    expect(mocks.revalidated).toEqual([]);
    expect((await readCategory("Groceries"))!.kind).toBe("expense");
  });

  it("still renames and archives a referenced category", async () => {
    // The rule is scoped to `kind`, not to the row. A category someone has
    // stopped using must stay renameable and archivable while its historical
    // rows keep resolving through it.
    const groceries = await readCategory("Groceries");

    const renamed = await actions.updateCategoryAction(
      IDLE,
      formData({ id: groceries!.id, name: "Groceries (old)", kind: "expense" })
    );
    expect(renamed.status).toBe("success");
    expect((await readCategory("Groceries (old)"))!.id).toBe(groceries!.id);

    const archived = await actions.setCategoryArchivedAction(
      IDLE,
      formData({ id: groceries!.id, archived: "true" })
    );
    expect(archived.status).toBe("success");
    expect((await readCategory("Groceries (old)"))!.isArchived).toBe(true);

    // Put it back, so later tests and a manual smoke see the seed as it was.
    await actions.updateCategoryAction(
      IDLE,
      formData({ id: groceries!.id, name: "Groceries", kind: "expense" })
    );
    await actions.setCategoryArchivedAction(
      IDLE,
      formData({ id: groceries!.id, archived: "false" })
    );
  });

  it("refuses the kind change for a category referenced only by a budget", async () => {
    // A different reference column from the transaction case above. Proving
    // them separately is the point: a guard that only checked transactions
    // would pass that test and fail this one.
    const { data } = await context.client
      .from("budgets")
      .select("category_id")
      .limit(1)
      .single();
    const categoryId = (data as { category_id: string }).category_id;

    const current = (await getCategories()).find((category) => category.id === categoryId);
    expect(current).toBeDefined();

    const state = await actions.updateCategoryAction(
      IDLE,
      formData({
        id: categoryId,
        name: current!.name,
        kind: current!.kind === "expense" ? "income" : "expense",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe(
      "This category is already in use, so its type can no longer be changed."
    );
  });

  it("refuses the kind change for a category referenced only by a bill", async () => {
    const { data } = await context.client
      .from("bills")
      .select("category_id")
      .not("category_id", "is", null)
      .limit(1)
      .single();
    const categoryId = (data as { category_id: string }).category_id;

    const current = (await getCategories()).find((category) => category.id === categoryId);
    expect(current).toBeDefined();

    const state = await actions.updateCategoryAction(
      IDLE,
      formData({
        id: categoryId,
        name: current!.name,
        kind: current!.kind === "expense" ? "income" : "expense",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe(
      "This category is already in use, so its type can no longer be changed."
    );
  });

  it("reports a duplicate name on rename", async () => {
    const created = await createCategory("CP2 Collider", "expense");
    mocks.revalidated = [];

    const state = await actions.updateCategoryAction(
      IDLE,
      formData({ id: created.id, name: "Dining", kind: "expense" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("You already have a category with that name.");
    expect((await readCategory("CP2 Collider"))!.name).toBe("CP2 Collider");
  });
});

describe("setCategoryArchivedAction", () => {
  it("archives and unarchives, and archived categories stay readable throughout", async () => {
    const created = await createCategory("CP2 Archivable Category", "expense");
    mocks.revalidated = [];

    const archived = await actions.setCategoryArchivedAction(
      IDLE,
      formData({ id: created.id, archived: "true" })
    );
    expect(archived.status).toBe("success");
    expect(mocks.revalidated).toEqual(CATEGORY_ROUTES);

    // Still returned by getCategories() — that is what keeps the label on a
    // historical transaction from going blank.
    const whileArchived = await readCategory("CP2 Archivable Category");
    expect(whileArchived).toBeDefined();
    expect(whileArchived!.isArchived).toBe(true);

    const unarchived = await actions.setCategoryArchivedAction(
      IDLE,
      formData({ id: created.id, archived: "false" })
    );
    expect(unarchived.status).toBe("success");
    expect((await readCategory("CP2 Archivable Category"))!.isArchived).toBe(false);
  });

  it("reports a clean not-found for an id the owner does not have", async () => {
    const state = await actions.setCategoryArchivedAction(
      IDLE,
      formData({ id: "00000000-0000-4000-8000-000000000000", archived: "true" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("rejects an archive flag that is neither 'true' nor 'false'", async () => {
    const created = await readCategory("CP2 Coffee");

    const state = await actions.setCategoryArchivedAction(
      IDLE,
      formData({ id: created!.id, archived: "yes" })
    );

    expect(state.status).toBe("error");
    expect((await readCategory("CP2 Coffee"))!.isArchived).toBe(false);
  });
});

describe("privileges the application never uses are unreachable from the owner's own client", () => {
  it("cannot reassign a category to another owner", async () => {
    const category = await readCategory("Dining");

    const { error } = await context.client
      .from("categories")
      .update({ user_id: "00000000-0000-4000-8000-000000000000" })
      .eq("id", category!.id);

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("cannot delete a category", async () => {
    const category = await readCategory("CP2 Probe");

    const { error } = await context.client.from("categories").delete().eq("id", category!.id);

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(await readCategory("CP2 Probe")).toBeDefined();
  });

  it("cannot create a category owned by someone else", async () => {
    const { error } = await context.client.from("categories").insert({
      user_id: "00000000-0000-4000-8000-000000000000",
      name: "CP2 Foreign Category",
      kind: "expense",
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(await readCategory("CP2 Foreign Category")).toBeUndefined();
  });

  it("cannot bypass the kind guard by writing straight to PostgREST", async () => {
    // The decisive one. The mutation layer's preflight is a message layer; this
    // proves the database refuses the same change with the DAL taken out of the
    // path entirely, which is exactly what a compromised session would do.
    const groceries = await readCategory("Groceries");

    const { error } = await context.client
      .from("categories")
      .update({ kind: "income" })
      .eq("id", groceries!.id);

    expect(error).not.toBeNull();
    // 23514 — check_violation, raised by guard_category_kind_change().
    expect(error!.code).toBe("23514");
    expect((await readCategory("Groceries"))!.kind).toBe("expense");
  });
});

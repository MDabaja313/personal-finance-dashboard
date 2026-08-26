import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError, isAppError } from "@/lib/errors";

/**
 * The DAL seam's identity contract. `@/lib/supabase/server` is mocked because
 * the real client calls `next/headers`'s `cookies()`, which has no meaning
 * outside a request scope — the point here is `getOwnerId()`'s behavior, not
 * the SSR client's.
 */
const mocks = vi.hoisted(() => {
  const getClaims = vi.fn();
  const getSession = vi.fn();
  const createClient = vi.fn(async () => ({ auth: { getClaims, getSession } }));
  return { getClaims, getSession, createClient };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

const { getDataClient, getOwnerId } = await import("@/lib/data/supabase");

const OWNER_ID = "c9152b5e-a931-4fe5-907a-64325a1a47ff";

function claims(value: unknown) {
  return { data: { claims: value }, error: null };
}

async function caught(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (isAppError(error)) return error;
    throw new Error(`Expected an AppError, received: ${String(error)}`);
  }
  throw new Error("Expected getOwnerId to throw, but it resolved.");
}

beforeEach(() => {
  mocks.getClaims.mockReset();
  mocks.getSession.mockReset();
  mocks.createClient.mockClear();
});

describe("getDataClient", () => {
  it("builds the client through lib/supabase/server", async () => {
    mocks.getClaims.mockResolvedValue(claims({ sub: OWNER_ID }));

    const client = await getDataClient();

    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(client.auth.getClaims).toBe(mocks.getClaims);
  });
});

describe("getOwnerId", () => {
  it("returns the verified `sub` claim", async () => {
    mocks.getClaims.mockResolvedValue(claims({ sub: OWNER_ID, email: "owner@example.invalid" }));

    await expect(getOwnerId()).resolves.toBe(OWNER_ID);
  });

  it("obtains its client through getDataClient rather than constructing a second one", async () => {
    mocks.getClaims.mockResolvedValue(claims({ sub: OWNER_ID }));

    await getOwnerId();

    expect(mocks.createClient).toHaveBeenCalledTimes(1);
  });

  it("authorizes through getClaims and never touches getSession", async () => {
    mocks.getClaims.mockResolvedValue(claims({ sub: OWNER_ID }));

    await getOwnerId();

    expect(mocks.getClaims).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("throws unauthorized when claim verification fails", async () => {
    const authError = { name: "AuthApiError", message: "invalid JWT", status: 401 };
    mocks.getClaims.mockResolvedValue({ data: null, error: authError });

    const error = await caught(() => getOwnerId());

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("unauthorized");
    expect(error.cause).toBe(authError);
  });

  it("throws unauthorized when there are no claims at all", async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: null });

    expect((await caught(() => getOwnerId())).code).toBe("unauthorized");
  });

  it("throws unauthorized for a missing, empty, or non-string `sub`", async () => {
    for (const sub of [undefined, "", 12345, null]) {
      mocks.getClaims.mockResolvedValue(claims({ sub }));

      expect((await caught(() => getOwnerId())).code).toBe("unauthorized");
    }
  });

  it("throws rather than redirecting, so a Server Action gets an error not a navigation", async () => {
    // A redirect() would throw Next's NEXT_REDIRECT control-flow error, which
    // is not an AppError. `caught` rejects anything that isn't one.
    mocks.getClaims.mockResolvedValue({ data: null, error: null });

    const error = await caught(() => getOwnerId());

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).not.toContain("NEXT_REDIRECT");
  });

  it("never quotes the raw auth error in the user-facing message", async () => {
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: { message: "JWSError JWSInvalidSignature: signature verification failed" },
    });

    const error = await caught(() => getOwnerId());

    expect(error.message).toBe("Not authenticated.");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves lib/auth/recovery.ts's confirmRecovery: it always redirects, never
 * accepts a client-supplied redirect target (no open-redirect surface), and
 * never leaks a raw Supabase error into the redirect it issues. Exercises
 * the PKCE `exchangeCodeForSession` path — the flow `@supabase/ssr` v0.12.4
 * actually uses (hardcoded `flowType: "pkce"` on both its clients), which is
 * what makes this work with Supabase's *default*, unmodified email template.
 */

const exchangeCodeForSession = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession },
  })),
}));

const redirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...(args as [string])),
}));

const { confirmRecovery } = await import("@/lib/auth/recovery");

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  redirect.mockClear();
});

describe("confirmRecovery", () => {
  it("exchanges a valid recovery code and redirects to /reset-password", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { session: {}, user: {}, redirectType: "recovery" },
      error: null,
    });

    await expect(confirmRecovery("valid-code")).rejects.toThrow("REDIRECT:/reset-password");

    expect(exchangeCodeForSession).toHaveBeenCalledWith("valid-code");
  });

  it("redirects to /forgot-password?expired=1 when the exchange reports an error (expired or already-used link)", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null, redirectType: null },
      error: { message: "invalid flow state, no valid flow state found", status: 400 },
    });

    await expect(confirmRecovery("stale-code")).rejects.toThrow("REDIRECT:/forgot-password?expired=1");
  });

  it("redirects to /forgot-password?expired=1 when the exchange succeeds but is not a recovery redirect", async () => {
    // Defense-in-depth: this app has no other PKCE-code-generating flow, so
    // this should be unreachable in practice, but the endpoint must not
    // treat an unexpected redirectType as a valid recovery completion.
    exchangeCodeForSession.mockResolvedValue({
      data: { session: {}, user: {}, redirectType: null },
      error: null,
    });

    await expect(confirmRecovery("some-code")).rejects.toThrow("REDIRECT:/forgot-password?expired=1");
  });

  it("never calls exchangeCodeForSession and redirects to the expired page when code is missing", async () => {
    await expect(confirmRecovery(null)).rejects.toThrow("REDIRECT:/forgot-password?expired=1");

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("never leaks the raw Supabase error into the redirect target", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null, redirectType: null },
      error: { message: 'relation "auth.users" does not exist', status: 500 },
    });

    let caught: unknown;
    try {
      await confirmRecovery("code");
    } catch (error) {
      caught = error;
    }

    expect(String(caught)).not.toContain("auth.users");
    expect(String(caught)).toBe("Error: REDIRECT:/forgot-password?expired=1");
  });
});

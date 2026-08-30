import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves lib/auth/recovery.ts's confirmRecovery: it always redirects, never
 * accepts a client-supplied redirect target (no open-redirect surface), and
 * never leaks a raw Supabase error into the redirect it issues.
 */

const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp },
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
  verifyOtp.mockReset();
  redirect.mockClear();
});

describe("confirmRecovery", () => {
  it("verifies the token and redirects to /reset-password on success", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: null });

    await expect(confirmRecovery("valid-hash", "recovery")).rejects.toThrow("REDIRECT:/reset-password");

    expect(verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "valid-hash" });
  });

  it("redirects to /forgot-password?expired=1 when verifyOtp reports an error (expired or already-used link)", async () => {
    verifyOtp.mockResolvedValue({
      data: null,
      error: { message: "Token has expired or is invalid", status: 403 },
    });

    await expect(confirmRecovery("stale-hash", "recovery")).rejects.toThrow(
      "REDIRECT:/forgot-password?expired=1"
    );
  });

  it("never calls verifyOtp and redirects to the expired page when token_hash is missing", async () => {
    await expect(confirmRecovery(null, "recovery")).rejects.toThrow("REDIRECT:/forgot-password?expired=1");

    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("never calls verifyOtp and redirects to the expired page when type is missing", async () => {
    await expect(confirmRecovery("some-hash", null)).rejects.toThrow(
      "REDIRECT:/forgot-password?expired=1"
    );

    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("never calls verifyOtp when type is anything other than the literal 'recovery' — this endpoint has exactly one purpose", async () => {
    await expect(confirmRecovery("some-hash", "signup")).rejects.toThrow(
      "REDIRECT:/forgot-password?expired=1"
    );

    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("never leaks the raw Supabase error into the redirect target", async () => {
    verifyOtp.mockResolvedValue({
      data: null,
      error: { message: 'relation "auth.users" does not exist', status: 500 },
    });

    let caught: unknown;
    try {
      await confirmRecovery("hash", "recovery");
    } catch (error) {
      caught = error;
    }

    expect(String(caught)).not.toContain("auth.users");
    expect(String(caught)).toBe("Error: REDIRECT:/forgot-password?expired=1");
  });
});

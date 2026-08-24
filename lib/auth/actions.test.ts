import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the generic-error contract in lib/auth/actions.ts: whatever the
 * Supabase Auth error actually says, the caller only ever sees the fixed
 * INVALID_CREDENTIALS message — never the raw message/code/status, which
 * would otherwise let a client distinguish "no such account" from "wrong
 * password" (an account-enumeration oracle).
 */

const GENERIC_ERROR = "Invalid email or password.";

const signInWithPassword = vi.fn();
const authSignOut = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword,
      signOut: authSignOut,
    },
  })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...args),
}));

const { signIn, signOut } = await import("@/lib/auth/actions");

function formDataFor(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  signInWithPassword.mockReset();
  authSignOut.mockReset();
  revalidatePath.mockReset();
  redirect.mockReset();
});

describe("signIn — generic login error mapping", () => {
  it("maps a raw invalid-credentials error to only the generic message", async () => {
    signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials", status: 400, code: "invalid_credentials" },
    });

    const result = await signIn(
      { error: null },
      formDataFor({ email: " user@example.com ", password: "wrongpass" })
    );

    expect(result).toEqual({ error: GENERIC_ERROR });
    // Trimmed before being sent, regardless of what comes back.
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "wrongpass",
    });
  });

  it.each([
    { message: "Email not confirmed", status: 400, code: "email_not_confirmed" },
    { message: "User not found: internal-lookup-detail", status: 404, code: "user_not_found" },
    {
      message: "Too many requests, rate limit exceeded for IP 10.0.0.1",
      status: 429,
      code: "over_request_rate_limit",
    },
    { message: 'relation "auth.users" does not exist', status: 500, code: undefined },
  ])("never leaks the raw Auth error ($message) into the result", async (rawError) => {
    signInWithPassword.mockResolvedValue({ error: rawError });

    const result = await signIn(
      { error: null },
      formDataFor({ email: "user@example.com", password: "whatever" })
    );

    expect(result.error).toBe(GENERIC_ERROR);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawError.message);
    if (rawError.code) expect(serialized).not.toContain(rawError.code);
    expect(serialized).not.toContain(String(rawError.status));
  });

  it("rejects a missing email without calling Supabase, using the same generic message", async () => {
    const result = await signIn({ error: null }, formDataFor({ password: "somepassword" }));

    expect(result).toEqual({ error: GENERIC_ERROR });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("rejects a missing password without calling Supabase, using the same generic message", async () => {
    const result = await signIn({ error: null }, formDataFor({ email: "user@example.com" }));

    expect(result).toEqual({ error: GENERIC_ERROR });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("on success, revalidates the app shell and redirects to /dashboard", async () => {
    signInWithPassword.mockResolvedValue({ error: null });

    await signIn(
      { error: null },
      formDataFor({ email: "user@example.com", password: "correct-password" })
    );

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });
});

describe("signOut", () => {
  it("signs out, revalidates the app shell, and redirects to /login", async () => {
    authSignOut.mockResolvedValue({ error: null });

    await signOut();

    expect(authSignOut).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

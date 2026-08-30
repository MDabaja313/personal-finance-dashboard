import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the generic-error contract in lib/auth/actions.ts: whatever the
 * Supabase Auth error actually says, the caller only ever sees the fixed
 * INVALID_CREDENTIALS message — never the raw message/code/status, which
 * would otherwise let a client distinguish "no such account" from "wrong
 * password" (an account-enumeration oracle).
 */

const GENERIC_ERROR = "Invalid email or password.";
const RESET_REQUESTED = "If that email is registered, a password reset link has been sent.";

const signInWithPassword = vi.fn();
const authSignOut = vi.fn();
const resetPasswordForEmail = vi.fn();
const updateUser = vi.fn();
const getClaims = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword,
      signOut: authSignOut,
      resetPasswordForEmail,
      updateUser,
      getClaims,
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

const headersGet = vi.fn();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
}));

const { signIn, signOut, requestPasswordReset, updatePassword } = await import("@/lib/auth/actions");

function formDataFor(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  signInWithPassword.mockReset();
  authSignOut.mockReset();
  resetPasswordForEmail.mockReset();
  updateUser.mockReset();
  getClaims.mockReset();
  // Verified-session happy path by default — requireUser()/getVerifiedClaims()
  // (called from updatePassword) reads this. Individual tests override it to
  // simulate no session.
  getClaims.mockResolvedValue({ data: { claims: { sub: "owner-id", email: "owner@example.com" } }, error: null });
  revalidatePath.mockReset();
  redirect.mockReset();
  headersGet.mockReset();
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

describe("requestPasswordReset", () => {
  it("in production, derives redirectTo from the request's own deployed Origin — never a hardcoded localhost", async () => {
    headersGet.mockReturnValue("https://personal-finance-dashboard-beta-one.vercel.app");
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });

    const result = await requestPasswordReset(
      { status: "idle", message: null },
      formDataFor({ email: "owner@example.com" })
    );

    expect(resetPasswordForEmail).toHaveBeenCalledWith("owner@example.com", {
      redirectTo: "https://personal-finance-dashboard-beta-one.vercel.app/auth/confirm",
    });
    expect(result).toEqual({ status: "success", message: RESET_REQUESTED });
  });

  it("in local development, derives redirectTo from the request's own localhost Origin — never a hardcoded production URL", async () => {
    headersGet.mockReturnValue("http://localhost:3000");
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });

    await requestPasswordReset({ status: "idle", message: null }, formDataFor({ email: "owner@example.com" }));

    expect(resetPasswordForEmail).toHaveBeenCalledWith("owner@example.com", {
      redirectTo: "http://localhost:3000/auth/confirm",
    });
  });

  it("returns the same generic success message even when resetPasswordForEmail reports an error — never an account-enumeration signal", async () => {
    headersGet.mockReturnValue("https://personal-finance-dashboard-beta-one.vercel.app");
    resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { message: "User not found", status: 404 },
    });

    const result = await requestPasswordReset(
      { status: "idle", message: null },
      formDataFor({ email: "nobody@example.com" })
    );

    expect(result).toEqual({ status: "success", message: RESET_REQUESTED });
  });

  it("returns the generic success message without calling Supabase when the email field is empty", async () => {
    const result = await requestPasswordReset({ status: "idle", message: null }, formDataFor({}));

    expect(result).toEqual({ status: "success", message: RESET_REQUESTED });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("fails safely without calling Supabase when the request has no Origin header", async () => {
    headersGet.mockReturnValue(null);

    const result = await requestPasswordReset(
      { status: "idle", message: null },
      formDataFor({ email: "owner@example.com" })
    );

    expect(result.status).toBe("error");
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("updatePassword", () => {
  it("re-verifies the session first — an unauthenticated caller is redirected to /login and updateUser is never reached", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "invalid JWT" } });
    redirect.mockImplementationOnce((path: string) => {
      throw new Error(`REDIRECT:${path}`);
    });

    await expect(
      updatePassword({ error: null }, formDataFor({ password: "a-fine-password" }))
    ).rejects.toThrow("REDIRECT:/login");

    expect(updateUser).not.toHaveBeenCalled();
  });

  it("rejects a password shorter than 8 characters without calling Supabase", async () => {
    const result = await updatePassword({ error: null }, formDataFor({ password: "short" }));

    expect(result).toEqual({ error: "Password must be at least 8 characters." });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it.each([
    { message: "New password should be different from the old password.", status: 422 },
    { message: 'relation "auth.users" does not exist', status: 500 },
  ])("never leaks the raw Auth error ($message) into the result", async (rawError) => {
    updateUser.mockResolvedValue({ data: null, error: rawError });

    const result = await updatePassword({ error: null }, formDataFor({ password: "a-fine-password" }));

    expect(result.error).toBe("Something went wrong. Please try again.");
    expect(JSON.stringify(result)).not.toContain(rawError.message);
  });

  it("on success: updates the password, signs out, revalidates the app shell, and redirects to /login?reset=success", async () => {
    updateUser.mockResolvedValue({ data: {}, error: null });
    authSignOut.mockResolvedValue({ error: null });

    await updatePassword({ error: null }, formDataFor({ password: "a-fine-password" }));

    expect(updateUser).toHaveBeenCalledWith({ password: "a-fine-password" });
    expect(authSignOut).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/login?reset=success");
  });
});

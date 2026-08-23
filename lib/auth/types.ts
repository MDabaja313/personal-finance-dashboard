/**
 * Shared auth types. Deliberately free of `server-only` and of any
 * Supabase import: the login form is a Client Component and needs the
 * form-state shape at the type level. Nothing here carries a value at
 * runtime.
 */

/** The verified identity behind a request. Never built from `getSession()`. */
export interface VerifiedUser {
  /** `sub` from the verified access token — the `auth.uid()` every row is scoped to. */
  id: string;
  email: string | null;
}

/** `useActionState` state for the login form. */
export interface SignInState {
  /**
   * A message safe to show the visitor. Always generic — the login form
   * never reveals whether the email exists, whether the password was
   * wrong, or anything else the Auth server said.
   */
  error: string | null;
}

/** The `signIn` Server Action's signature, as `useActionState` sees it. */
export type SignInAction = (state: SignInState, formData: FormData) => Promise<SignInState>;

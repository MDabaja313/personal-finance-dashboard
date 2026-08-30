import type { NextRequest } from "next/server";

import { confirmRecovery } from "@/lib/auth/recovery";

/**
 * Password-recovery email link target. Public — a signed-out visitor is
 * exactly who reaches this from their inbox, the same way `/login` is
 * public for the same reason. Named `callback`, not `confirm`: this reads
 * a PKCE `code` query parameter and exchanges it server-side
 * (`exchangeCodeForSession`), rather than verifying a `token_hash` — see
 * `lib/auth/recovery.ts` for why. `confirmRecovery` always redirects; this
 * route never itself returns a response body.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  await confirmRecovery(searchParams.get("code"));
}

import type { NextRequest } from "next/server";

import { confirmRecovery } from "@/lib/auth/recovery";

/**
 * Password-recovery email link target. Public — a signed-out visitor is
 * exactly who reaches this from their inbox, the same way `/login` is public
 * for the same reason. `confirmRecovery` always redirects; this route never
 * itself returns a response body. See docs/auth-design.md and
 * lib/auth/recovery.ts.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  await confirmRecovery(searchParams.get("token_hash"), searchParams.get("type"));
}

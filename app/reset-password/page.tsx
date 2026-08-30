import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { updatePassword } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Set new password",
};

/**
 * Reached from the recovery email link (`app/auth/confirm` → here) or an
 * ordinary active login. Deliberately not under `app/(app)/**` — this is a
 * one-off page, not part of the authenticated app shell, so it renders its
 * own minimal centered layout rather than the sidebar/header — but it still
 * re-verifies its own identity requirement directly, the same way every
 * independently reachable protected surface does (docs/auth-design.md §10):
 * `requireUser()` redirects to `/login` if there is no verified session.
 */
export default async function ResetPasswordPage() {
  await requireUser();

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Set a new password</CardTitle>
            <CardDescription>Choose a new password for your account.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResetPasswordForm updateAction={updatePassword} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

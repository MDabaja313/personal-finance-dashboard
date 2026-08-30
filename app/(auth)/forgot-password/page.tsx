import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requestPasswordReset } from "@/lib/auth/actions";
import { getVerifiedClaims } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Reset password",
};

interface ForgotPasswordPageProps {
  searchParams: Promise<{ expired?: string }>;
}

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  // Verified claims, not a cookie-backed session (docs/auth-design.md §5).
  // Someone already signed in has no business requesting a reset link.
  if (await getVerifiedClaims()) redirect("/dashboard");

  const { expired } = await searchParams;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>Enter your email and we&apos;ll send you a reset link.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {expired ? (
          <p className="text-sm text-muted-foreground">
            That link has expired or was already used. Request a new one below.
          </p>
        ) : null}
        <ForgotPasswordForm requestAction={requestPasswordReset} />
        <Link href="/login" className="text-sm text-muted-foreground underline underline-offset-4">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}

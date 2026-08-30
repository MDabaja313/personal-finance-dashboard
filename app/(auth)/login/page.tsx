import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signIn } from "@/lib/auth/actions";
import { getVerifiedClaims } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Sign in",
};

interface LoginPageProps {
  searchParams: Promise<{ reset?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // Verified claims, not a cookie-backed session (docs/auth-design.md §5).
  // Someone already signed in has no business on the login form.
  if (await getVerifiedClaims()) redirect("/dashboard");

  const { reset } = await searchParams;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Personal Finance Dashboard</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {reset === "success" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Your password has been updated. Sign in with your new password.
          </p>
        ) : null}
        <LoginForm signInAction={signIn} />
      </CardContent>
    </Card>
  );
}

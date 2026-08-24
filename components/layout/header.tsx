import { LogOut } from "lucide-react";

import { MobileSidebar } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";

export function Header({
  email,
  signOutAction,
}: {
  email: string | null;
  signOutAction: () => Promise<void>;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      <MobileSidebar />
      <span className="font-heading text-sm font-semibold text-foreground lg:hidden">
        Finance Dashboard
      </span>
      <div className="ml-auto flex items-center gap-3">
        {email && <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>}
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </form>
      </div>
    </header>
  );
}

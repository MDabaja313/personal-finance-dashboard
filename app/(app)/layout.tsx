import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { requireUser } from "@/lib/auth/session";
import { signOut } from "@/lib/auth/actions";

/**
 * Application shell — the single guard point for every route under
 * app/(app)/. `requireUser()` redirects to /login when no verified identity
 * is present (docs/auth-design.md §7); it is not wrapped in try/catch here,
 * since that would swallow the `redirect()` it throws to signal navigation.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header email={user.email} signOutAction={signOut} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

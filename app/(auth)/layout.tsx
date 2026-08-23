/**
 * Shell for the public auth routes. Deliberately outside the `(app)`
 * group: it has no sidebar, no header, and — unlike `(app)` from
 * Checkpoint A3 onward — no identity guard, since a signed-out visitor is
 * exactly who these routes are for.
 *
 * `/login` is the only route in this group. There is no signup route.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

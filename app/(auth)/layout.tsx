/**
 * Shell for the public auth routes. Deliberately outside the `(app)`
 * group: it has no sidebar, no header, and — unlike `(app)` from
 * Checkpoint A3 onward — no identity guard, since a signed-out visitor is
 * exactly who these routes are for.
 *
 * `/login` and `/forgot-password` are the only routes in this group — both
 * for a signed-out visitor. There is no signup route. `/reset-password`
 * (the opposite case: requires a verified session) is deliberately *not*
 * in this group — see app/reset-password/page.tsx.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

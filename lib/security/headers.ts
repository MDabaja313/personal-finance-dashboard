/**
 * CP8A's security header set, applied to every route via `next.config.ts`.
 * Lives here rather than inline in the config file so it has a colocated
 * Vitest suite like everything else in `lib/**` — `next.config.ts` itself is
 * outside Vitest's `lib/**` include glob and isn't a place tests can reach.
 *
 * No Content-Security-Policy: this application loads no third-party script,
 * font, or style host (Recharts and every shadcn/ui primitive render
 * entirely client-bundled), so a hand-rolled CSP would be a maintenance
 * burden with no attack surface behind it to justify it, and a wrong
 * directive could silently break Supabase auth's redirect flow or the chart
 * library. `Strict-Transport-Security` is deliberately absent too: Vercel
 * adds it automatically for every HTTPS deployment on a custom domain, and
 * setting it again here risks a second, conflicting value rather than
 * adding protection — see docs/operations.md.
 */
export const securityHeaders: { key: string; value: string }[] = [
  // Stops the browser from guessing a response's content type — this app
  // has no upload/attachment surface to exploit, but free to set and never
  // a regression.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // A private financial dashboard has no reason to ever render inside
  // another site's frame — refuses framing outright rather than allowing a
  // same-origin embed nothing in this app uses.
  { key: "X-Frame-Options", value: "DENY" },
  // Sends the full referrer on a same-origin navigation but only the
  // origin, never the full path/query, to a cross-origin destination.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // This application never uses the camera, microphone, geolocation, or
  // payment APIs — turned off outright rather than left to the browser's
  // permissive default.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

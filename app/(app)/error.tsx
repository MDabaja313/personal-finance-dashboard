"use client"; // Error boundaries must be Client Components.

import { ErrorState } from "@/components/shared/error-state";

/**
 * One shared boundary for all 8 routes under app/(app)/ — it wraps this
 * segment's pages and nested layouts but not app/(app)/layout.tsx itself
 * (Next.js error.js semantics), so the sidebar and header stay mounted and
 * interactive when this renders.
 *
 * `retry` (stable since Next.js 16.3.0, this repo is on 16.3.1) re-fetches
 * and re-renders the boundary's children — preferred over `reset()`, which
 * only clears error state without re-fetching.
 *
 * No client-side logging here: Next.js already reports server errors with
 * the matching `digest`, and this repo has no client observability system
 * that would consume a browser console log.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ErrorState retry={retry} digest={error.digest} />;
}

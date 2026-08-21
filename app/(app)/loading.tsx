import { PageSkeleton } from "@/components/shared/page-skeleton";

/**
 * One shared Suspense fallback for all 8 routes under app/(app)/. Wraps
 * this segment's page.js and nested layouts, not app/(app)/layout.tsx
 * itself, so the sidebar and header stay mounted while this shows.
 *
 * The mock DAL is synchronous, so this will rarely appear on its own today
 * — it exists as scaffolding for Phase 6, when data fetching actually
 * suspends.
 */
export default function Loading() {
  return <PageSkeleton />;
}

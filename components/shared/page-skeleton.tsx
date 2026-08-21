import { Skeleton } from "@/components/shared/skeleton";

/**
 * Generic route-level loading fallback — a page-header shape plus a few
 * content blocks. Deliberately not page-specific: it is shared by every
 * route in app/(app)/loading.tsx, the same way error.tsx is one shared
 * boundary rather than eight near-identical ones.
 */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

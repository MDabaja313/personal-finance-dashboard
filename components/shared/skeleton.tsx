import { cn } from "@/lib/utils";

/** Minimal loading placeholder — a pulsing block sized by the caller's className. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden="true" />;
}

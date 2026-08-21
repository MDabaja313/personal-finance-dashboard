import { Compass } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Root 404 for any unmatched URL. Nested inside app/layout.tsx (unlike the
 * experimental global-not-found.js, which bypasses the layout entirely and
 * would need its own theme/fonts/styles wired up manually) — this repo has
 * one static root layout, so nesting is both simpler and correct, and it
 * means this page follows the app's light/dark/system theme rather than
 * only the OS color scheme, which is what Next.js's built-in 404 does.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <Compass className="size-8 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
      </div>
      <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }))}>
        Return to Dashboard
      </Link>
    </div>
  );
}

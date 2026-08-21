import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  /** Re-fetches and re-renders the boundary's children (Next.js `retry()`). */
  retry: () => void;
  /** Server-generated reference hash a user can quote when reporting the issue. */
  digest?: string;
  className?: string;
}

/**
 * Presentation-only. Deliberately generic: a Server Component error reaches
 * the client as a message-plus-digest only (see lib/errors.ts), so there is
 * no `error.message` or error code to show here — showing one would either
 * be empty in production or, in dev, risk surfacing something this
 * component has no way to know is safe to display.
 */
export function ErrorState({ retry, digest, className }: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center",
        className
      )}
    >
      <AlertTriangle className="size-8 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Something went wrong</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          An unexpected error occurred. Try again, or come back later.
        </p>
        {digest && <p className="text-xs text-muted-foreground">Reference: {digest}</p>}
      </div>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

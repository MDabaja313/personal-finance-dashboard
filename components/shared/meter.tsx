import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface MeterProps {
  label: string;
  /** The real, uncapped percentage — may exceed 100 or be negative. Never destroyed for display. */
  value: number;
  /** Overrides the default `value`-based text, e.g. "$450 of $250 spent". */
  valueLabel?: string;
  status?: "default" | "over";
  className?: string;
}

/**
 * Accessible progress meter. The bar's CSS width is clamped to [0, 100] so
 * layout can never overflow, but the textual value is never clamped — an
 * over-budget or over-funded state is allowed to show its real percentage.
 * Status is conveyed by an icon + text, never by color alone.
 */
export function Meter({ label, value, valueLabel, status = "default", className }: MeterProps) {
  const clampedWidth = Math.min(100, Math.max(0, value));
  const isOver = status === "over";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground",
            isOver && "text-destructive"
          )}
        >
          {isOver && <AlertTriangle className="size-3.5" aria-hidden="true" />}
          {valueLabel ?? `${value}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clampedWidth)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", isOver ? "bg-destructive" : "bg-primary")}
          style={{ width: `${clampedWidth}%` }}
        />
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "negative";
  className?: string;
}

export function StatTile({ label, value, hint, tone = "default", className }: StatTileProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={cn("text-2xl font-semibold", tone === "negative" && "text-destructive")}>
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

"use client";

import { Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: SunMoon },
] as const;

/**
 * Uses `theme`, not `resolvedTheme` — `theme` is undefined on both the
 * server and the initial client render (matching, so no hydration
 * mismatch), and only resolves once next-themes' provider mounts.
 * `resolvedTheme` would need a `mounted` guard since it depends on the
 * OS preference, which the server can't know.
 */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="inline-flex gap-1 rounded-lg border border-border p-1" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          type="button"
          variant={theme === value ? "secondary" : "ghost"}
          size="sm"
          role="radio"
          aria-checked={theme === value}
          onClick={() => setTheme(value)}
          className="gap-1.5"
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </Button>
      ))}
    </div>
  );
}

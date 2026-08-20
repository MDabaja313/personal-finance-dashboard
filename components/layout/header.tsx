import { MobileSidebar } from "@/components/layout/sidebar";

export function Header() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      <MobileSidebar />
      <span className="font-heading text-sm font-semibold text-foreground lg:hidden">
        Finance Dashboard
      </span>
    </header>
  );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Account, Category } from "@/lib/types";
import { optionItems, selectItems } from "@/lib/ui/select-items";

const ALL = "all";

/**
 * Every kind a stored row can carry, including the ones the entry form cannot
 * create. Filtering and creating are different questions: a transfer leg or a
 * reconciliation adjustment is exactly the sort of row a person wants to
 * isolate, and offering no way to filter for it would make it unfindable in a
 * long history.
 */
const KIND_OPTIONS = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "refund", label: "Refund" },
  { value: "transfer", label: "Transfer" },
  { value: "credit_card_payment", label: "Card Payment" },
  { value: "adjustment", label: "Adjustment" },
];

interface TransactionFiltersProps {
  months: { value: string; label: string }[];
  accounts: Account[];
  categories: Category[];
}

/**
 * Filtering is server-side (see lib/data/transactions.ts) — this component
 * only edits the URL's search params, which triggers a normal Next.js
 * navigation and re-render of the Server Component page. No client-side
 * fetching, no local data state.
 */
export function TransactionFilters({ months, accounts, categories }: TransactionFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Base UI's `<Select.Value>` resolves its text from the Root's `items` map
   * and falls back to `String(value)` without one — so the account and category
   * filters rendered a raw UUID once something was selected, and the type
   * filter rendered `credit_card_payment`. The values in the URL are unchanged;
   * only the trigger's text is. See `lib/ui/select-items.ts`.
   */
  const monthLabels = useMemo(
    () => selectItems([{ value: ALL, label: "All months" }, ...months]),
    [months]
  );
  const accountLabels = useMemo(
    () => optionItems(accounts, { value: ALL, label: "All accounts" }),
    [accounts]
  );
  const categoryLabels = useMemo(
    () => optionItems(categories, { value: ALL, label: "All categories" }),
    [categories]
  );
  const kindLabels = useMemo(
    () => selectItems([{ value: ALL, label: "All types" }, ...KIND_OPTIONS]),
    []
  );

  /**
   * The single funnel every filter control goes through — which is what makes
   * the pagination reset below unmissable rather than something each control
   * has to remember.
   *
   * Changing a filter changes *which* rows exist, so a reveal depth measured
   * against the previous filter set is meaningless: keeping `page=4` would
   * either over-fetch a now-short list or, worse, present a arbitrarily deep
   * slice of a different result as if the user had asked for it. Dropping the
   * param (rather than setting `page=1`) also keeps the common URL clean and
   * identical to the pre-pagination one, so existing shareable/bookmarkable
   * filter URLs are unchanged.
   */
  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === ALL) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    params.delete("page");
    router.push(`/transactions?${params.toString()}`);
  }

  function onSearchChange(value: string) {
    setSearchValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setParam("search", value), 300);
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <Select
        items={monthLabels}
        value={searchParams.get("month") ?? ALL}
        onValueChange={(value) => setParam("month", String(value))}
      >
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="Month" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All months</SelectItem>
          {months.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={accountLabels}
        value={searchParams.get("account") ?? ALL}
        onValueChange={(value) => setParam("account", String(value))}
      >
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue placeholder="Account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All accounts</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={categoryLabels}
        value={searchParams.get("category") ?? ALL}
        onValueChange={(value) => setParam("category", String(value))}
      >
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All categories</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={kindLabels}
        value={searchParams.get("kind") ?? ALL}
        onValueChange={(value) => setParam("kind", String(value))}
      >
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          {KIND_OPTIONS.map((k) => (
            <SelectItem key={k.value} value={k.value}>
              {k.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search merchant…"
        aria-label="Search merchant"
        className="w-full sm:w-48"
      />
    </div>
  );
}

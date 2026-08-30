"use client";

import { Plus } from "lucide-react";
import { useActionState, useCallback, useEffect, useId, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionState, FormAction } from "@/lib/actions/types";
import type { Category } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Category management, kept to one section of the existing `/settings` page.
 *
 * Deliberately not a new route or a settings sub-system: categories are the
 * only thing CP2 makes manageable besides accounts, and a route built for one
 * list would have to be dismantled the moment budgets and bills arrive. A
 * section on the page that already exists is the smallest coherent home for it.
 *
 * Archived categories stay in this list — this is the management view, and
 * hiding them here is exactly how an archive becomes irreversible. They are
 * marked, so the state is visible, and it is *future entry* pickers that will
 * filter on `isArchived` once transaction and budget forms exist.
 *
 * Every action arrives as a prop. `components/**` may not value-import
 * `lib/actions/**`; the route hands them down.
 */

const INITIAL_STATE: ActionState = { status: "idle", formError: null, fieldErrors: {} };

const KIND_OPTIONS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
] as const;

const KIND_LABEL: Record<Category["kind"], string> = { expense: "Expense", income: "Income" };

export interface CategoryMutationActions {
  readonly create: FormAction;
  readonly update: FormAction;
  readonly setArchived: FormAction;
}

export function CategoryManager({
  categories,
  actions,
}: {
  categories: Category[];
  actions: CategoryMutationActions;
}) {
  return (
    <div className="flex flex-col gap-4">
      <AddCategory action={actions.create} />

      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {categories.map((category) => (
            <li key={category.id} className="py-2">
              <CategoryRow
                category={category}
                updateAction={actions.update}
                setArchivedAction={actions.setArchived}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The collapsed "New category" disclosure. */
function AddCategory({ action }: { action: FormAction }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          New category
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <CategoryFields
        action={action}
        submitLabel="Add category"
        onSuccess={close}
        onCancel={close}
      />
    </div>
  );
}

/** One category: name, kind, archive state, and its controls. */
function CategoryRow({
  category,
  updateAction,
  setArchivedAction,
}: {
  category: Category;
  updateAction: FormAction;
  setArchivedAction: FormAction;
}) {
  const [editing, setEditing] = useState(false);
  const stopEditing = useCallback(() => setEditing(false), []);

  if (editing) {
    return (
      <CategoryFields
        action={updateAction}
        category={category}
        submitLabel="Save"
        onSuccess={stopEditing}
        onCancel={stopEditing}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn("flex-1 truncate text-sm", category.isArchived && "text-muted-foreground")}>
        {category.name}
      </span>
      <Badge variant="outline" className="shrink-0">
        {KIND_LABEL[category.kind]}
      </Badge>
      {category.isArchived && (
        <Badge variant="secondary" className="shrink-0">
          Archived
        </Badge>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <ArchiveToggle
        action={setArchivedAction}
        categoryId={category.id}
        isArchived={category.isArchived}
      />
    </div>
  );
}

/**
 * The shared create/edit fields.
 *
 * `kind` is always submitted, including on edit and including when unchanged —
 * the mutation layer compares it against the stored value and only treats a
 * genuine difference as a change, which is what keeps renaming a category that
 * already has transactions working.
 */
function CategoryFields({
  action,
  category,
  submitLabel,
  onSuccess,
  onCancel,
}: {
  action: FormAction;
  category?: Category;
  submitLabel: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [kind, setKind] = useState<Category["kind"]>(category?.kind ?? "expense");

  const nameId = useId();
  const kindId = useId();
  const formErrorId = useId();

  useEffect(() => {
    if (state.status === "success") onSuccess();
  }, [state, onSuccess]);

  const submitted = state.values;
  const nameErrors = state.fieldErrors.name ?? [];
  const kindErrors = state.fieldErrors.kind ?? [];

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {category && <input type="hidden" name="id" value={category.id} />}

      <div className="flex flex-wrap items-end gap-2">
        <FieldShell id={nameId} label="Name" className="min-w-40 flex-1">
          <Input
            id={nameId}
            name="name"
            defaultValue={submitted?.name ?? category?.name ?? ""}
            required
            maxLength={120}
            disabled={pending}
            aria-invalid={nameErrors.length > 0 || undefined}
            aria-describedby={nameErrors.length > 0 ? `${nameId}-error` : undefined}
          />
        </FieldShell>

        <FieldShell id={kindId} label="Type" className="w-36">
          <Select
            name="kind"
            value={kind}
            onValueChange={(value) => setKind(value as Category["kind"])}
            disabled={pending}
          >
            <SelectTrigger id={kindId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldShell>

        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>

      {nameErrors.length > 0 && (
        <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
          {nameErrors.join(" ")}
        </p>
      )}
      {kindErrors.length > 0 && (
        <p id={`${kindId}-error`} role="alert" className="text-xs text-destructive">
          {kindErrors.join(" ")}
        </p>
      )}
      {state.formError !== null && (
        <p id={formErrorId} role="alert" className="text-xs text-destructive">
          {state.formError}
        </p>
      )}
    </form>
  );
}

function ArchiveToggle({
  action,
  categoryId,
  isArchived,
}: {
  action: FormAction;
  categoryId: string;
  isArchived: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const errorId = useId();

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="id" value={categoryId} />
        {/* The target state, not a toggle — see the account version for why. */}
        <input type="hidden" name="archived" value={isArchived ? "false" : "true"} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-describedby={state.formError ? errorId : undefined}
        >
          {pending ? "Saving…" : isArchived ? "Unarchive" : "Archive"}
        </Button>
      </form>

      {state.formError !== null && (
        <p id={errorId} role="alert" className="basis-full text-xs text-destructive">
          {state.formError}
        </p>
      )}
    </>
  );
}

function FieldShell({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

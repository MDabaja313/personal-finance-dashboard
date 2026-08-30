import { CategoryManager } from "@/components/settings/category-manager";
import { SettingsSection } from "@/components/settings/settings-section";
import { ThemeSelector } from "@/components/settings/theme-selector";
import { PageHeader } from "@/components/shared/page-header";
import {
  createCategoryAction,
  setCategoryArchivedAction,
  updateCategoryAction,
} from "@/lib/actions/categories";
import { getCategories } from "@/lib/data/categories";

/**
 * Categories live here rather than on a route of their own: `/settings` already
 * exists, already holds the application's non-financial configuration, and a
 * route built for one list would have to be dismantled the moment budgets and
 * bills need managing too.
 *
 * The Server Actions are imported at this layer and passed down as props —
 * `components/**` may not value-import `lib/actions/**`.
 */
export default async function SettingsPage() {
  const categories = await getCategories();

  const categoryActions = {
    create: createCategoryAction,
    update: updateCategoryAction,
    setArchived: setCategoryArchivedAction,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Application preferences." />

      <SettingsSection title="Appearance" description="Choose how the app looks.">
        <ThemeSelector />
      </SettingsSection>

      <SettingsSection
        title="Categories"
        description="Rename, retype, and archive the categories transactions and budgets are grouped by. Archived categories stay on historical rows but are kept out of new entries."
      >
        <CategoryManager categories={categories} actions={categoryActions} />
      </SettingsSection>

      <SettingsSection
        title="Currency"
        description="Not yet available — this app currently supports USD only."
        disabled
      >
        <p className="text-sm text-muted-foreground">USD ($)</p>
      </SettingsSection>

      <SettingsSection title="Financial Preferences" description="Not yet available in this phase." disabled>
        <p className="text-sm text-muted-foreground">
          Budget periods, default accounts, and notification preferences will appear here.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Data & Import"
        description="Not yet available — no external data connections exist yet."
        disabled
      >
        <p className="text-sm text-muted-foreground">
          Bank connections and CSV import will appear here in a later phase.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Security & Account"
        description="Not yet available — this app does not have authentication yet."
        disabled
      >
        <p className="text-sm text-muted-foreground">
          Sign-in and account security settings will appear here once authentication is added.
        </p>
      </SettingsSection>
    </div>
  );
}

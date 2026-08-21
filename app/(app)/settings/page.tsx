import { SettingsSection } from "@/components/settings/settings-section";
import { ThemeSelector } from "@/components/settings/theme-selector";
import { PageHeader } from "@/components/shared/page-header";

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Application preferences." />

      <SettingsSection title="Appearance" description="Choose how the app looks.">
        <ThemeSelector />
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

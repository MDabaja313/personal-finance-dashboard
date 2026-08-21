import { AccountGroup } from "@/components/accounts/account-group";
import { PageHeader } from "@/components/shared/page-header";
import { getAccounts } from "@/lib/data/accounts";
import { accountKind, totalAssets, totalLiabilities } from "@/lib/finance/accounts";

export default async function AccountsPage() {
  const accounts = await getAccounts();
  const active = accounts.filter((a) => !a.isArchived);
  const assets = active.filter((a) => accountKind(a.type) === "asset");
  const liabilities = active.filter((a) => accountKind(a.type) === "liability");
  const archived = accounts.filter((a) => a.isArchived);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Accounts" description="All accounts, grouped by assets and liabilities." />

      <AccountGroup title="Assets" accounts={assets} subtotal={totalAssets(accounts)} />
      <AccountGroup
        title="Liabilities"
        accounts={liabilities}
        subtotal={totalLiabilities(accounts)}
        subtotalTone="negative"
      />
      <AccountGroup title="Archived" accounts={archived} />
    </div>
  );
}

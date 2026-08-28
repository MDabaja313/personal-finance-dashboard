import { AccountGroup } from "@/components/accounts/account-group";
import { AddAccount } from "@/components/accounts/add-account";
import { PageHeader } from "@/components/shared/page-header";
import {
  createAccountAction,
  setAccountArchivedAction,
  updateAccountAction,
} from "@/lib/actions/accounts";
import { getAccounts } from "@/lib/data/accounts";
import { accountKind, totalAssets, totalLiabilities } from "@/lib/finance/accounts";

/**
 * The account management surface.
 *
 * The Server Actions are imported here, in `app/**`, and handed to the client
 * components as props — `components/**` may not value-import `lib/actions/**`,
 * and may not reach `lib/data/mutations/**` at all. The route is the seam.
 *
 * Archived accounts keep their own group and keep their controls, so an
 * account archived by mistake can be brought back. They stay excluded from the
 * asset/liability subtotals, which is `lib/finance/accounts.ts`'s rule and is
 * unchanged.
 */
export default async function AccountsPage() {
  const accounts = await getAccounts();
  const active = accounts.filter((a) => !a.isArchived);
  const assets = active.filter((a) => accountKind(a.type) === "asset");
  const liabilities = active.filter((a) => accountKind(a.type) === "liability");
  const archived = accounts.filter((a) => a.isArchived);

  const actions = { update: updateAccountAction, setArchived: setAccountArchivedAction };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Accounts" description="All accounts, grouped by assets and liabilities." />

      <AddAccount action={createAccountAction} />

      <AccountGroup
        title="Assets"
        accounts={assets}
        subtotal={totalAssets(accounts)}
        actions={actions}
      />
      <AccountGroup
        title="Liabilities"
        accounts={liabilities}
        subtotal={totalLiabilities(accounts)}
        subtotalTone="negative"
        actions={actions}
      />
      <AccountGroup title="Archived" accounts={archived} actions={actions} />
    </div>
  );
}

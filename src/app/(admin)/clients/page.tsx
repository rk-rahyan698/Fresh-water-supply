import type { Metadata } from "next";
import { UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { ClientList } from "@/components/clients/client-list";
import { FilterBar, UrlSearchInput, UrlSelect } from "@/components/filters/url-controls";
import { listClients } from "@/lib/queries/clients";
import { t } from "@/lib/i18n";
import type { ClientStatus } from "@/types/database";

export const metadata: Metadata = { title: "Clients" };

const STATUS_OPTIONS = [
  { value: "active", label: t.client.active },
  { value: "inactive", label: t.client.inactive },
  { value: "all", label: t.common.all },
];

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const search = params.q ?? "";
  const status = (params.status as ClientStatus | "all") ?? "active";
  const page = Number(params.page ?? 1);

  const { clients, total, pageCount } = await listClients({ search, status, page });

  return (
    <>
      <PageHeader
        title={t.client.many}
        description={`${total} ${status === "all" ? "" : status} ${total === 1 ? "client" : "clients"}`}
        action={
          <LinkButton href="/clients/new" size="md">
            <UserPlus className="size-4.5" />
            <span className="hidden sm:inline">{t.client.add}</span>
            <span className="sm:hidden">Add</span>
          </LinkButton>
        }
      />

      <FilterBar>
        <UrlSearchInput
          initialValue={search}
          placeholder={t.client.searchPlaceholder}
          className="min-w-0 flex-1"
        />
        <UrlSelect
          param="status"
          value={status}
          options={STATUS_OPTIONS}
          ariaLabel={t.client.status}
          className="w-32 shrink-0"
        />
      </FilterBar>

      <ClientList
        clients={clients}
        basePath="/clients"
        page={page}
        pageCount={pageCount}
        total={total}
        searching={Boolean(search)}
        emptyAction={
          !search ? (
            <LinkButton href="/clients/new" size="sm">
              <UserPlus className="size-4" />
              {t.client.add}
            </LinkButton>
          ) : undefined
        }
      />
    </>
  );
}

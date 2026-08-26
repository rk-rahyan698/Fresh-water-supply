import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { ClientList } from "@/components/clients/client-list";
import { FilterBar, UrlSearchInput } from "@/components/filters/url-controls";
import { listClients } from "@/lib/queries/clients";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Clients" };

export default async function CollectorClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const search = params.q ?? "";
  const page = Number(params.page ?? 1);

  // Collectors only ever work with active clients.
  const { clients, total, pageCount } = await listClients({ search, status: "active", page });

  return (
    <>
      <PageHeader
        title={t.client.many}
        description="Tap a client to see their bill and collect payment."
      />

      <FilterBar>
        <UrlSearchInput
          initialValue={search}
          placeholder={t.client.searchPlaceholder}
          className="min-w-0 flex-1"
        />
      </FilterBar>

      <ClientList
        clients={clients}
        basePath="/my/clients"
        page={page}
        pageCount={pageCount}
        total={total}
        searching={Boolean(search)}
      />
    </>
  );
}

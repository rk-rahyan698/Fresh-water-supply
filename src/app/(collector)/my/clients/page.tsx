import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { ClientList } from "@/components/clients/client-list";
import { FilterBar, UrlSearchInput, UrlSelect } from "@/components/filters/url-controls";
import { listClients } from "@/lib/queries/clients";
import { listAreas } from "@/lib/queries/areas";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Clients" };

export default async function CollectorClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; area?: string; page?: string }>;
}) {
  const params = await searchParams;
  const search = params.q ?? "";
  const page = Number(params.page ?? 1);

  // Collectors only ever work with active clients.
  const [areas, { clients, total, pageCount }] = await Promise.all([
    listAreas(false),
    listClients({ search, status: "active", areaId: params.area || undefined, page }),
  ]);

  return (
    <>
      <PageHeader
        title={t.client.many}
        description="Tap a client to see their bill and collect payment."
      />

      <FilterBar
        alwaysVisible={
          <UrlSearchInput
            initialValue={search}
            placeholder={t.client.searchPlaceholder}
            className="min-w-0 flex-1"
          />
        }
      >
        {areas.length > 0 && (
          <UrlSelect
            param="area"
            value={params.area ?? ""}
            label={t.area.one}
            options={[
              { value: "", label: t.area.all },
              ...areas.map((a) => ({ value: a.id, label: a.name })),
            ]}
            className="w-full sm:w-40"
          />
        )}
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

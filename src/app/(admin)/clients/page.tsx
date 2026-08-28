import type { Metadata } from "next";
import { UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { ClientOverviewList } from "@/components/clients/client-overview-list";
import { FilterBar, UrlSearchInput, UrlSelect } from "@/components/filters/url-controls";
import { listClientOverview } from "@/lib/queries/clients";
import { listAreas } from "@/lib/queries/areas";
import { dhakaCurrentMonth, formatMonth, monthOptions, toMonthStart } from "@/lib/format";
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
  searchParams: Promise<{
    q?: string;
    status?: string;
    area?: string;
    month?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const search = params.q ?? "";
  const status = (params.status as ClientStatus | "all") ?? "active";
  const month = params.month ? toMonthStart(params.month) : dhakaCurrentMonth();
  const page = Number(params.page ?? 1);

  // "none" is the sentinel for clients with no area, so they stay reachable.
  const areaFilter = params.area === "none" ? undefined : params.area || undefined;

  const [areas, result] = await Promise.all([
    listAreas(),
    listClientOverview({ month, areaId: areaFilter, search, status, page }),
  ]);

  // The RPC has no "unassigned only" mode, so filter that case in the app.
  const rows = params.area === "none" ? result.rows.filter((r) => !r.areaId) : result.rows;

  return (
    <>
      <PageHeader
        title={t.client.many}
        description={`${result.total} ${status === "all" ? "" : status} ${result.total === 1 ? "client" : "clients"} · ${formatMonth(month)}`}
        action={
          <LinkButton href="/clients/new" size="md">
            <UserPlus className="size-4.5" />
            <span className="hidden sm:inline">{t.client.add}</span>
            <span className="sm:hidden">Add</span>
          </LinkButton>
        }
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
        <UrlSelect
          param="area"
          value={params.area ?? ""}
          label={t.area.one}
          options={[
            { value: "", label: t.area.all },
            ...areas.map((a) => ({ value: a.id, label: a.name })),
            { value: "none", label: t.area.unassigned },
          ]}
          className="w-full sm:w-40"
        />
        <UrlSelect
          param="month"
          value={month}
          label={t.common.month}
          options={monthOptions(12)}
          className="w-full sm:w-40"
        />
        <UrlSelect
          param="status"
          value={status}
          label={t.client.status}
          options={STATUS_OPTIONS}
          className="w-full sm:w-32"
        />
      </FilterBar>

      <ClientOverviewList
        rows={rows}
        month={month}
        basePath="/clients"
        page={page}
        pageCount={result.pageCount}
        total={result.total}
        searching={Boolean(search) || Boolean(params.area)}
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

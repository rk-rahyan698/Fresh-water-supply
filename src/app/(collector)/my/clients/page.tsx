import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import {
  BILL_STATE_OPTIONS,
  ClientOverviewList,
  clientCountLabel,
} from "@/components/clients/client-overview-list";
import { FilterBar, UrlSearchInput, UrlSelect } from "@/components/filters/url-controls";
import { listClientOverview, parseBillState } from "@/lib/queries/clients";
import { listAreas } from "@/lib/queries/areas";
import { dhakaCurrentMonth, formatMonth, monthOptions, toMonthStart } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Clients" };

export default async function CollectorClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; area?: string; month?: string; bill?: string; page?: string }>;
}) {
  const params = await searchParams;
  const search = params.q ?? "";
  const month = params.month ? toMonthStart(params.month) : dhakaCurrentMonth();
  const billState = parseBillState(params.bill);
  const page = Number(params.page ?? 1);

  // Collectors only ever work with active clients.
  const [areas, result] = await Promise.all([
    listAreas(false),
    listClientOverview({
      month,
      areaId: params.area || undefined,
      search,
      status: "active",
      billState,
      page,
    }),
  ]);

  return (
    <>
      <PageHeader
        title={t.client.many}
        description={`${clientCountLabel(result.total, billState)} · ${formatMonth(month)}. Tap a client to see their bill and collect payment.`}
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
          param="bill"
          value={billState ?? ""}
          label={t.bill.stateFilter}
          options={BILL_STATE_OPTIONS}
          className="w-full sm:w-36"
        />
        <UrlSelect
          param="month"
          value={month}
          label={t.common.month}
          options={monthOptions(12)}
          className="w-full sm:w-40"
        />
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

      <ClientOverviewList
        rows={result.rows}
        month={month}
        basePath="/my/clients"
        page={page}
        pageCount={result.pageCount}
        total={result.total}
        searching={Boolean(search) || Boolean(params.area) || Boolean(billState)}
        showPaymentsAction={false}
      />
    </>
  );
}

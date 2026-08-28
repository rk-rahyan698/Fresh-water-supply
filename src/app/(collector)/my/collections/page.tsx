import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { PaymentsTable } from "@/components/payments/payments-table";
import { FilterBar, UrlDateInput, UrlSelect } from "@/components/filters/url-controls";
import { requireUser } from "@/lib/auth";
import { listPayments } from "@/lib/queries/payments";
import { getCollectorStats } from "@/lib/queries/reports";
import {
  dhakaCurrentMonth,
  dhakaToday,
  formatCurrency,
  formatMonth,
  monthOptions,
  toMonthStart,
} from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "My Collections" };

export default async function MyCollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; month?: string; page?: string }>;
}) {
  const ctx = await requireUser();
  const params = await searchParams;
  const page = Number(params.page ?? 1);
  const month = dhakaCurrentMonth();

  const [stats, result] = await Promise.all([
    getCollectorStats(ctx.userId, month),
    listPayments({
      collectorId: ctx.userId,
      from: params.from,
      to: params.to,
      billingMonth: params.month ? toMonthStart(params.month) : undefined,
      includeVoided: true,
      page,
    }),
  ]);

  return (
    <>
      <PageHeader
        title={t.nav.myCollections}
        description="Every payment you have recorded."
      />

      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <StatCard label={t.dashboard.todayCollection} value={formatCurrency(stats.today_collection)} />
        <StatCard
          label={formatMonth(month)}
          value={formatCurrency(stats.month_collection)}
          tone="brand"
        />
        <StatCard label="All time" value={formatCurrency(stats.total_collection)} />
      </div>

      <FilterBar>
        <UrlDateInput
          param="from"
          value={params.from ?? ""}
          label={t.common.from}
          max={dhakaToday()}
          className="w-full sm:w-40"
        />
        <UrlDateInput
          param="to"
          value={params.to ?? ""}
          label={t.common.to}
          max={dhakaToday()}
          className="w-full sm:w-40"
        />
        <UrlSelect
          param="month"
          value={params.month ?? ""}
          label={t.bill.billingMonth}
          options={[{ value: "", label: `${t.common.all} months` }, ...monthOptions(12)]}
          className="w-full sm:w-44"
        />
      </FilterBar>

      <PaymentsTable
        payments={result.payments}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        sum={result.sum}
        showCollector={false}
        clientBasePath="/my/clients"
        emptyDescription="No payments match these filters."
      />
    </>
  );
}

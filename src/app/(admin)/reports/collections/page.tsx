import type { Metadata } from "next";
import { HandCoins, Users, Receipt, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { CollectionReportTable } from "@/components/reports/collection-report-table";
import { FilterBar, UrlSelect } from "@/components/filters/url-controls";
import {
  getCollectionMatrix,
  getCollectionSummary,
  getPaymentYears,
} from "@/lib/queries/collection-report";
import { listAreas } from "@/lib/queries/areas";
import { listCollectors } from "@/lib/queries/reports";
import { dhakaToday, formatCurrency } from "@/lib/format";
import { env } from "@/lib/env";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Collection Report" };

export default async function CollectionReportPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; area?: string; collector?: string }>;
}) {
  const params = await searchParams;

  // Years come from the data, never hardcoded (spec section 10).
  const [years, areas, collectors] = await Promise.all([
    getPaymentYears(),
    listAreas(),
    listCollectors(),
  ]);

  const currentYear = Number(dhakaToday().slice(0, 4));
  const yearOptions = years.length > 0 ? years : [currentYear];
  const year = Number(params.year) || yearOptions[0];
  const areaId = params.area || undefined;
  const collectorId = params.collector || undefined;

  const filters = { year, areaId, collectorId };
  const [rows, summary] = await Promise.all([
    getCollectionMatrix(filters),
    getCollectionSummary(filters),
  ]);

  const areaLabel = areaId ? (areas.find((a) => a.id === areaId)?.name ?? "Area") : "All areas";
  const collectorLabel = collectorId
    ? (collectors.find((c) => c.id === collectorId)?.full_name ?? "Collector")
    : "All collectors";

  return (
    <>
      <PageHeader
        title={t.collections.title}
        description={`${year} · ${t.collections.description}`}
      />

      {/* One filter row scoping the table, the summary and both exports. */}
      <FilterBar>
        <UrlSelect
          param="year"
          value={String(year)}
          label={t.collections.year}
          options={yearOptions.map((y) => ({ value: String(y), label: String(y) }))}
          className="w-full sm:w-32"
        />
        <UrlSelect
          param="area"
          value={params.area ?? ""}
          label={t.area.one}
          options={[
            { value: "", label: t.area.all },
            ...areas.map((a) => ({ value: a.id, label: a.name })),
          ]}
          className="w-full sm:w-44"
        />
        <UrlSelect
          param="collector"
          value={params.collector ?? ""}
          label={t.submission.collector}
          options={[
            { value: "", label: `${t.common.all} collectors` },
            ...collectors.map((c) => ({ value: c.id, label: c.full_name })),
          ]}
          className="w-full sm:w-48"
        />
      </FilterBar>

      {/* Collection figures - payment-date basis */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label={t.collections.totalCollected}
          value={formatCurrency(summary.total_collected)}
          sub={`during ${year}`}
          icon={HandCoins}
          tone="positive"
        />
        <StatCard
          label={t.collections.clients}
          value={summary.client_count}
          sub={`${summary.paying_clients} paid something`}
          icon={Users}
        />
        <StatCard
          label={t.collections.payments}
          value={summary.payment_count}
          icon={Receipt}
        />
        <StatCard
          label={t.collections.averagePayment}
          value={formatCurrency(summary.average_payment)}
          icon={TrendingUp}
        />
      </div>

      {/* Bill ladder - billing-month basis, labelled so the two are not confused */}
      <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label={t.bill.originalBill} value={formatCurrency(summary.original_amount)} />
        <StatCard
          label={t.bill.adjustment}
          value={formatCurrency(summary.adjustment_amount)}
          tone={summary.adjustment_amount > 0 ? "brand" : "default"}
        />
        <StatCard label={t.bill.adjustedBill} value={formatCurrency(summary.adjusted_amount)} />
        <StatCard
          label={t.report.totalDue}
          value={formatCurrency(summary.outstanding)}
          tone={summary.outstanding > 0 ? "danger" : "positive"}
        />
      </div>

      <p className="mt-2 mb-3 px-1 text-xs text-ink-faint">
        The first row follows the date money was received. The second follows the month each bill
        belongs to. Both come from the same records - they answer different questions.
      </p>

      <CollectionReportTable
        rows={rows}
        summary={summary}
        context={{
          year,
          areaLabel,
          collectorLabel,
          businessName: env.businessName,
        }}
      />
    </>
  );
}

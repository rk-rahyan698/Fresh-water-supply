import type { Metadata } from "next";
import Link from "next/link";
import {
  Users,
  ReceiptText,
  Wallet,
  TrendingUp,
  AlertTriangle,
  Banknote,
  Percent,
  ArrowRight,
} from "lucide-react";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/button";
import { PaymentMethodBadge } from "@/components/ui/badge";
import { MonthlyCollectionChart } from "@/components/charts/monthly-collection-chart";
import { CollectorCollectionChart } from "@/components/charts/collector-collection-chart";
import { FilterBar, UrlSelect } from "@/components/filters/url-controls";
import {
  getCollectorSeries,
  getDashboardSummary,
  getMonthlySeries,
} from "@/lib/queries/reports";
import { listPayments } from "@/lib/queries/payments";
import { listAreas } from "@/lib/queries/areas";
import {
  dhakaCurrentMonth,
  formatCurrency,
  formatDate,
  formatMonth,
  monthEnd,
  monthOptions,
  toMonthStart,
} from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; area?: string }>;
}) {
  const params = await searchParams;
  const month = params.month ? toMonthStart(params.month) : dhakaCurrentMonth();
  const areaId = params.area || undefined;

  // One round trip each, in parallel - the dashboard is the slowest screen
  // otherwise, and it is the first thing the owner opens.
  const [summary, monthly, collectors, recent, areas] = await Promise.all([
    getDashboardSummary(month, areaId),
    getMonthlySeries(6, areaId),
    getCollectorSeries(month, monthEnd(month), areaId),
    listPayments({ pageSize: 6, areaId }),
    listAreas(),
  ]);

  const areaName = areaId ? areas.find((a) => a.id === areaId)?.name : undefined;

  const monthLabel = formatMonth(month);
  const collectionRate =
    summary.billed_amount > 0
      ? Math.round((Number(summary.collected_amount) / Number(summary.billed_amount)) * 100)
      : 0;

  return (
    <>
      <PageHeader
        title={t.dashboard.title}
        description={`${monthLabel}${areaName ? ` · ${areaName}` : ""} · ${t.dashboard.receivedToday}: ${formatCurrency(summary.received_today)}`}
      />

      {/* One filter row scoping everything below it (sections 16, 22). */}
      <FilterBar>
        <UrlSelect
          param="month"
          value={month}
          label={t.common.month}
          options={monthOptions(18)}
          className="w-full sm:w-48"
        />
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
      </FilterBar>

      {/* Summary cards - section 13 */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3">
        <StatCard
          label={t.dashboard.activeClients}
          value={summary.active_clients}
          sub={`${summary.inactive_clients} inactive`}
          icon={Users}
          tone="brand"
          href="/clients"
        />
        <StatCard
          label={`${monthLabel} ${t.dashboard.monthBills}`}
          value={formatCurrency(summary.billed_amount)}
          // billed_amount is the ADJUSTED total, so collected + due reconciles
          // to it. When a discount exists, show where the number came from.
          sub={
            Number(summary.adjustment_amount) > 0
              ? `${summary.bill_count} bills · ${formatCurrency(summary.original_amount)} less ${formatCurrency(summary.adjustment_amount)} adjusted`
              : `${summary.bill_count} bills`
          }
          icon={ReceiptText}
          href={`/bills?month=${month}`}
        />
        <StatCard
          label={t.bill.adjustment}
          value={formatCurrency(summary.adjustment_amount)}
          sub={
            Number(summary.adjustment_amount) > 0
              ? `${summary.adjusted_count} discounted ${Number(summary.adjusted_count) === 1 ? "bill" : "bills"}`
              : "No discounts this month"
          }
          icon={Percent}
          tone={Number(summary.adjustment_amount) > 0 ? "brand" : "default"}
        />
        <StatCard
          label={`${monthLabel} ${t.dashboard.monthCollected}`}
          value={formatCurrency(summary.collected_amount)}
          sub={`${collectionRate}% of billed`}
          icon={TrendingUp}
          tone="positive"
        />
        <StatCard
          label={`${monthLabel} ${t.dashboard.monthDue}`}
          value={formatCurrency(summary.due_amount)}
          sub={`${summary.unpaid_count} unpaid · ${summary.partial_count} partial`}
          icon={AlertTriangle}
          tone={Number(summary.due_amount) > 0 ? "danger" : "positive"}
          href={`/reports/due?month=${month}`}
        />
        <StatCard
          label={t.dashboard.todayCollection}
          value={formatCurrency(summary.received_today)}
          sub={`${summary.payments_today} ${t.dashboard.paymentsCount}`}
          icon={Wallet}
          href="/reports/daily"
        />
        <StatCard
          label={t.dashboard.unsubmittedCash}
          value={formatCurrency(summary.unsubmitted_cash)}
          sub="Cash held by collectors"
          icon={Banknote}
          tone={Number(summary.unsubmitted_cash) > 0 ? "warning" : "positive"}
          href="/submissions"
        />
      </div>

      {/* Charts - section 14 */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <MonthlyCollectionChart data={monthly} />
        <CollectorCollectionChart
          data={collectors}
          description={`Collected during ${monthLabel}, by whoever took the money.`}
        />
      </div>

      {/* Recent activity */}
      <Card className="mt-4 overflow-hidden">
        <CardHeader
          title={t.dashboard.recentPayments}
          action={
            <LinkButton href="/collections" variant="secondary" size="sm">
              {t.common.viewAll}
              <ArrowRight className="size-4" />
            </LinkButton>
          }
        />
        {recent.payments.length === 0 ? (
          <EmptyState
            title={t.payment.empty}
            description="Payments recorded by you or your collectors will appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {recent.payments.map((payment) => (
              <li key={payment.id}>
                <Link
                  href={`/clients/${payment.clients?.id ?? ""}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-canvas/70 sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {payment.clients?.name ?? "-"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-soft">
                      {formatDate(payment.payment_date)} · {payment.collector?.full_name ?? "-"}
                      {payment.monthly_bills
                        ? ` · ${formatMonth(payment.monthly_bills.billing_month)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <PaymentMethodBadge method={payment.payment_method} />
                    <span className="tnum text-sm font-semibold text-ink">
                      {formatCurrency(payment.amount)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

import type { Metadata } from "next";
import { Users, ReceiptText, TrendingUp, AlertTriangle } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TFootRow, TH, THead, TR } from "@/components/ui/table";
import { CollectorCollectionChart } from "@/components/charts/collector-collection-chart";
import { FilterBar, UrlSelect } from "@/components/filters/url-controls";
import { getMonthlyReport } from "@/lib/queries/reports";
import { dhakaCurrentMonth, formatCurrency, formatMonth, monthOptions, toMonthStart } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Monthly Report" };

export default async function MonthlyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const month = params.month ? toMonthStart(params.month) : dhakaCurrentMonth();
  const report = await getMonthlyReport(month);

  const collectionRate =
    report.billedAmount > 0 ? Math.round((report.collectedAmount / report.billedAmount) * 100) : 0;

  return (
    <>
      <PageHeader
        title={t.report.monthly}
        description={`${formatMonth(month)} · ${t.report.monthlyDescription}`}
      />

      <FilterBar>
        <UrlSelect
          param="month"
          value={month}
          label={t.common.month}
          options={monthOptions(24)}
          className="w-full sm:w-56"
        />
      </FilterBar>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label={t.client.active}
          value={report.activeClients}
          sub={`${report.billCount} bills issued`}
          icon={Users}
          tone="brand"
        />
        <StatCard
          label={t.report.totalBilled}
          value={formatCurrency(report.billedAmount)}
          icon={ReceiptText}
        />
        <StatCard
          label={t.report.totalCollected}
          value={formatCurrency(report.collectedAmount)}
          sub={`${collectionRate}% of billed`}
          icon={TrendingUp}
          tone="positive"
        />
        <StatCard
          label={t.report.totalDue}
          value={formatCurrency(report.dueAmount)}
          sub={`${report.unpaidCount} unpaid · ${report.partialCount} partial`}
          icon={AlertTriangle}
          tone={report.dueAmount > 0 ? "danger" : "positive"}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader
            title="Bill status breakdown"
            description={`How the ${report.billCount} bills for ${formatMonth(month)} stand.`}
          />
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>{t.bill.status}</TH>
                  <TH align="right">Bills</TH>
                  <TH align="right">Share</TH>
                </TR>
              </THead>
              <TBody>
                <StatusRow label={t.bill.paidStatus} count={report.paidCount} total={report.billCount} />
                <StatusRow label={t.bill.partial} count={report.partialCount} total={report.billCount} />
                <StatusRow label={t.bill.unpaid} count={report.unpaidCount} total={report.billCount} />
              </TBody>
              <TFootRow>
                <TD>{t.report.grandTotal}</TD>
                <TD align="right" numeric>
                  {report.billCount}
                </TD>
                <TD align="right" numeric>
                  100%
                </TD>
              </TFootRow>
            </Table>
          </TableWrap>
          <div className="border-t border-line px-4 py-3 text-sm text-ink-soft sm:px-5">
            <p>
              Cash received during {formatMonth(month)}:{" "}
              <strong className="tnum text-ink">{formatCurrency(report.receivedInMonth)}</strong>{" "}
              across {report.paymentsInMonth} {t.dashboard.paymentsCount}.
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              This counts payments by the date they were taken, so it includes money collected this
              month against older bills.
            </p>
          </div>
        </Card>

        {report.collectors.length > 0 ? (
          <CollectorCollectionChart
            data={report.collectors}
            description={`Collected during ${formatMonth(month)}.`}
          />
        ) : (
          <Card>
            <CardHeader title={t.report.collectorWise} />
            <EmptyState title={t.report.noResults} description="No payments were taken this month." />
          </Card>
        )}
      </div>
    </>
  );
}

function StatusRow({ label, count, total }: { label: string; count: number; total: number }) {
  const share = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <TR>
      <TD className="font-medium">{label}</TD>
      <TD align="right" numeric>
        {count}
      </TD>
      <TD align="right" numeric className="text-ink-soft">
        {share}%
      </TD>
    </TR>
  );
}

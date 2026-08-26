import type { Metadata } from "next";
import { UserCheck, Wallet, Banknote, HandCoins } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TFootRow, TH, THead, TR } from "@/components/ui/table";
import { FilterBar, UrlDateInput, UrlSelect } from "@/components/filters/url-controls";
import {
  getCollectorDailyBreakdown,
  getCollectorStats,
  listCollectors,
} from "@/lib/queries/reports";
import { listSubmissions } from "@/lib/queries/payments";
import {
  dhakaCurrentMonth,
  dhakaToday,
  formatCurrency,
  formatDate,
  monthEnd,
} from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Collector Report" };

export default async function CollectorReportPage({
  searchParams,
}: {
  searchParams: Promise<{ collector?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const collectors = await listCollectors();

  const collectorId = params.collector || collectors[0]?.id;
  const from = params.from || dhakaCurrentMonth();
  const to = params.to || monthEnd(dhakaCurrentMonth());

  if (!collectorId) {
    return (
      <>
        <PageHeader title={t.report.collector} description={t.report.collectorDescription} />
        <Card>
          <EmptyState
            icon={UserCheck}
            title="No users yet"
            description="Add a collector from the Users page first."
          />
        </Card>
      </>
    );
  }

  const selected = collectors.find((collector) => collector.id === collectorId);

  const [stats, breakdown, submissions] = await Promise.all([
    getCollectorStats(collectorId),
    getCollectorDailyBreakdown(collectorId, from, to),
    listSubmissions({ collectorId, limit: 50 }),
  ]);

  const rangeTotal = breakdown.reduce((sum, row) => sum + row.total_amount, 0);
  const rangeCount = breakdown.reduce((sum, row) => sum + row.payments_count, 0);

  return (
    <>
      <PageHeader
        title={t.report.collector}
        description={selected ? `${selected.full_name} · ${t.report.collectorDescription}` : undefined}
      />

      <FilterBar>
        <UrlSelect
          param="collector"
          value={collectorId}
          label={t.submission.collector}
          options={collectors.map((collector) => ({
            value: collector.id,
            label: collector.full_name,
          }))}
          className="w-full sm:w-52"
        />
        <UrlDateInput param="from" value={from} label={t.common.from} max={dhakaToday()} className="w-full sm:w-40" />
        <UrlDateInput param="to" value={to} label={t.common.to} max={dhakaToday()} className="w-full sm:w-40" />
      </FilterBar>

      {/* All-time cash reconciliation - section 19 */}
      <div className="mb-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label={t.report.totalCollected}
          value={formatCurrency(stats.total_collection)}
          sub={`${stats.total_count} ${t.dashboard.paymentsCount} · all time`}
          icon={HandCoins}
          tone="brand"
        />
        <StatCard
          label={`${t.payment.cash} ${t.submission.collected.toLowerCase()}`}
          value={formatCurrency(stats.cash_collection)}
          sub="Cash only"
          icon={Wallet}
        />
        <StatCard
          label={t.submission.submitted}
          value={formatCurrency(stats.total_submitted)}
          icon={Banknote}
          tone="positive"
        />
        <StatCard
          label={t.submission.unsubmitted}
          value={formatCurrency(stats.unsubmitted)}
          sub="Cash still in hand"
          tone={stats.unsubmitted > 0 ? "warning" : "positive"}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Collection by date, within the selected range */}
        <Card className="overflow-hidden">
          <CardHeader
            title={t.report.byDate}
            description={`${formatDate(from)} - ${formatDate(to)}`}
          />
          {breakdown.length === 0 ? (
            <EmptyState title={t.report.noResults} description="No payments in this date range." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>{t.common.date}</TH>
                    <TH align="right">{t.report.collectionCount}</TH>
                    <TH align="right">{t.payment.amount}</TH>
                  </TR>
                </THead>
                <TBody>
                  {breakdown.map((row) => (
                    <TR key={row.collection_date}>
                      <TD className="whitespace-nowrap">{formatDate(row.collection_date)}</TD>
                      <TD align="right" numeric>
                        {row.payments_count}
                      </TD>
                      <TD align="right" numeric className="font-semibold">
                        {formatCurrency(row.total_amount)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFootRow>
                  <TD>{t.report.grandTotal}</TD>
                  <TD align="right" numeric>
                    {rangeCount}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(rangeTotal)}
                  </TD>
                </TFootRow>
              </Table>
            </TableWrap>
          )}
        </Card>

        {/* Their submission history */}
        <Card className="overflow-hidden">
          <CardHeader title={t.submission.many} description="All time" />
          {submissions.length === 0 ? (
            <EmptyState title={t.submission.empty} />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>{t.common.date}</TH>
                    <TH align="right">{t.payment.amount}</TH>
                    <TH>{t.submission.receivedBy}</TH>
                  </TR>
                </THead>
                <TBody>
                  {submissions.map((submission) => (
                    <TR key={submission.id}>
                      <TD className="whitespace-nowrap">
                        {formatDate(submission.submission_date)}
                      </TD>
                      <TD align="right" numeric className="font-semibold">
                        {formatCurrency(submission.amount)}
                      </TD>
                      <TD className="text-ink-soft">{submission.receiver?.full_name ?? "-"}</TD>
                    </TR>
                  ))}
                </TBody>
                <TFootRow>
                  <TD>{t.report.grandTotal}</TD>
                  <TD align="right" numeric>
                    {formatCurrency(stats.total_submitted)}
                  </TD>
                  <TD />
                </TFootRow>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}

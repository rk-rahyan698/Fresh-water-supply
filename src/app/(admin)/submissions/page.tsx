import type { Metadata } from "next";
import { Banknote, Wallet } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  MobileCard,
  MobileField,
  Table,
  TableWrap,
  TBody,
  TD,
  TFootRow,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import {
  SubmissionDialog,
  type CollectorBalance,
} from "@/components/submissions/submission-dialog";
import { listSubmissions } from "@/lib/queries/payments";
import { getCollectorStats, listCollectors } from "@/lib/queries/reports";
import { formatCurrency, formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Cash Submission" };

export default async function SubmissionsPage() {
  const collectors = await listCollectors();

  // One stats call per user - the RPC does the aggregation server-side.
  const balances: CollectorBalance[] = await Promise.all(
    collectors.map(async (collector) => {
      const stats = await getCollectorStats(collector.id);
      return {
        id: collector.id,
        name: collector.full_name,
        cashCollected: stats.cash_collection,
        submitted: stats.total_submitted,
        unsubmitted: stats.unsubmitted,
      };
    }),
  );

  // Only show people who have actually handled cash.
  const active = balances.filter(
    (balance) => balance.cashCollected > 0 || balance.submitted > 0,
  );

  const totals = active.reduce(
    (acc, balance) => ({
      collected: acc.collected + balance.cashCollected,
      submitted: acc.submitted + balance.submitted,
      unsubmitted: acc.unsubmitted + balance.unsubmitted,
    }),
    { collected: 0, submitted: 0, unsubmitted: 0 },
  );

  const submissions = await listSubmissions({ limit: 100 });

  return (
    <>
      <PageHeader
        title={t.submission.many}
        description={t.submission.cashNote}
        action={<SubmissionDialog collectors={balances} />}
      />

      <div className="mb-3 grid grid-cols-3 gap-2.5">
        <StatCard label={t.submission.collected} value={formatCurrency(totals.collected)} icon={Wallet} />
        <StatCard
          label={t.submission.submitted}
          value={formatCurrency(totals.submitted)}
          tone="positive"
          icon={Banknote}
        />
        <StatCard
          label={t.submission.unsubmitted}
          value={formatCurrency(totals.unsubmitted)}
          tone={totals.unsubmitted > 0 ? "warning" : "positive"}
        />
      </div>

      {/* Per-collector reconciliation - section 11 */}
      <Card className="mb-3 overflow-hidden">
        <CardHeader
          title="Collector balances"
          description="Cash collected minus cash submitted, all time."
        />
        {active.length === 0 ? (
          <EmptyState
            title="No cash collected yet"
            description="Once collectors record cash payments, their balances appear here."
          />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>{t.submission.collector}</TH>
                  <TH align="right">{t.submission.collected}</TH>
                  <TH align="right">{t.submission.submitted}</TH>
                  <TH align="right">{t.submission.unsubmitted}</TH>
                </TR>
              </THead>
              <TBody>
                {active.map((balance) => (
                  <TR key={balance.id}>
                    <TD className="font-medium">{balance.name}</TD>
                    <TD align="right" numeric>
                      {formatCurrency(balance.cashCollected)}
                    </TD>
                    <TD align="right" numeric className="text-positive">
                      {formatCurrency(balance.submitted)}
                    </TD>
                    <TD
                      align="right"
                      numeric
                      className={
                        balance.unsubmitted > 0 ? "font-semibold text-warning" : "text-ink-soft"
                      }
                    >
                      {formatCurrency(balance.unsubmitted)}
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFootRow>
                <TD>{t.report.grandTotal}</TD>
                <TD align="right" numeric>
                  {formatCurrency(totals.collected)}
                </TD>
                <TD align="right" numeric>
                  {formatCurrency(totals.submitted)}
                </TD>
                <TD align="right" numeric>
                  {formatCurrency(totals.unsubmitted)}
                </TD>
              </TFootRow>
            </Table>
          </TableWrap>
        )}
      </Card>

      {/* Submission history */}
      <Card className="overflow-hidden">
        <CardHeader title="Submission history" description={`${submissions.length} records`} />
        {submissions.length === 0 ? (
          <EmptyState icon={Banknote} title={t.submission.empty} />
        ) : (
          <>
            <div className="sm:hidden">
              {submissions.map((submission) => (
                <MobileCard key={submission.id}>
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {submission.collector?.full_name ?? "-"}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {formatDate(submission.submission_date)}
                      </p>
                    </div>
                    <span className="tnum text-base font-semibold text-ink">
                      {formatCurrency(submission.amount)}
                    </span>
                  </div>
                  <MobileField
                    label={t.submission.receivedBy}
                    value={submission.receiver?.full_name ?? "-"}
                  />
                  {submission.notes && (
                    <p className="mt-1.5 text-xs text-ink-faint italic">{submission.notes}</p>
                  )}
                </MobileCard>
              ))}
            </div>

            <TableWrap className="hidden sm:block">
              <Table>
                <THead>
                  <TR>
                    <TH>{t.submission.date}</TH>
                    <TH>{t.submission.collector}</TH>
                    <TH align="right">{t.submission.amount}</TH>
                    <TH>{t.submission.receivedBy}</TH>
                    <TH>{t.common.notes}</TH>
                  </TR>
                </THead>
                <TBody>
                  {submissions.map((submission) => (
                    <TR key={submission.id}>
                      <TD className="whitespace-nowrap">
                        {formatDate(submission.submission_date)}
                      </TD>
                      <TD className="font-medium">{submission.collector?.full_name ?? "-"}</TD>
                      <TD align="right" numeric className="font-semibold">
                        {formatCurrency(submission.amount)}
                      </TD>
                      <TD className="text-ink-soft">{submission.receiver?.full_name ?? "-"}</TD>
                      <TD className="max-w-xs truncate text-ink-soft">{submission.notes ?? "-"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </>
        )}
      </Card>
    </>
  );
}

import type { Metadata } from "next";
import { Banknote, Wallet, HandCoins } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TFootRow, TH, THead, TR } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { getCollectorStats } from "@/lib/queries/reports";
import { listSubmissions } from "@/lib/queries/payments";
import { formatCurrency, formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "My Submissions" };

export default async function MySubmissionsPage() {
  const ctx = await requireUser();

  const [stats, submissions] = await Promise.all([
    getCollectorStats(ctx.userId),
    listSubmissions({ collectorId: ctx.userId, limit: 100 }),
  ]);

  return (
    <>
      <PageHeader
        title={t.nav.mySubmissions}
        description="Cash you have handed over to the owner."
      />

      <div className="grid grid-cols-3 gap-2.5">
        <StatCard
          label={`${t.payment.cash} ${t.submission.collected.toLowerCase()}`}
          value={formatCurrency(stats.cash_collection)}
          icon={HandCoins}
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
          sub="In your hand"
          icon={Wallet}
          tone={stats.unsubmitted > 0 ? "warning" : "positive"}
        />
      </div>

      <p className="mt-3 mb-3 rounded-xl bg-brand-50 px-3.5 py-3 text-sm text-brand-700">
        {t.submission.cashNote} Only the owner can record a submission - hand over the cash and ask
        them to enter it.
      </p>

      <Card className="overflow-hidden">
        <CardHeader title={t.submission.many} description={`${submissions.length} records`} />
        {submissions.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title={t.submission.empty}
            description="Once you hand cash to the owner and they record it, it appears here."
          />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>{t.submission.date}</TH>
                  <TH align="right">{t.submission.amount}</TH>
                  <TH>{t.submission.receivedBy}</TH>
                  <TH>{t.common.notes}</TH>
                </TR>
              </THead>
              <TBody>
                {submissions.map((submission) => (
                  <TR key={submission.id}>
                    <TD className="whitespace-nowrap">{formatDate(submission.submission_date)}</TD>
                    <TD align="right" numeric className="font-semibold">
                      {formatCurrency(submission.amount)}
                    </TD>
                    <TD className="text-ink-soft">{submission.receiver?.full_name ?? "-"}</TD>
                    <TD className="max-w-xs truncate text-ink-soft">{submission.notes ?? "-"}</TD>
                  </TR>
                ))}
              </TBody>
              <TFootRow>
                <TD>{t.report.grandTotal}</TD>
                <TD align="right" numeric>
                  {formatCurrency(stats.total_submitted)}
                </TD>
                <TD />
                <TD />
              </TFootRow>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

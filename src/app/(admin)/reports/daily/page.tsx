import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TFootRow, TH, THead, TR } from "@/components/ui/table";
import { PaymentsTable } from "@/components/payments/payments-table";
import { FilterBar, UrlDateInput, UrlSelect } from "@/components/filters/url-controls";
import { getDailyCollection } from "@/lib/queries/reports";
import { listPayments } from "@/lib/queries/payments";
import { listAreas } from "@/lib/queries/areas";
import { dhakaToday, formatCurrency, formatDateLong } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Daily Collection" };

export default async function DailyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; area?: string; page?: string }>;
}) {
  const params = await searchParams;
  const date = params.date || dhakaToday();
  const page = Number(params.page ?? 1);

  const areaId = params.area || undefined;
  const [rows, payments, areas] = await Promise.all([
    getDailyCollection(date, areaId),
    listPayments({ from: date, to: date, areaId, page, pageSize: 50 }),
    listAreas(),
  ]);

  const total = rows.reduce((sum, row) => sum + row.total_amount, 0);
  const count = rows.reduce((sum, row) => sum + row.payments_count, 0);

  return (
    <>
      <PageHeader title={t.report.daily} description={t.report.dailyDescription} />

      <FilterBar>
        <UrlDateInput
          param="date"
          value={date}
          label={t.common.date}
          max={dhakaToday()}
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

      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <StatCard
          label={formatDateLong(date)}
          value={formatCurrency(total)}
          sub={`${count} ${t.dashboard.paymentsCount}`}
          tone="brand"
          icon={CalendarDays}
        />
        <StatCard label="Collectors active" value={rows.length} />
        <StatCard
          label="Average payment"
          value={formatCurrency(count > 0 ? Math.round(total / count) : 0)}
        />
      </div>

      <Card className="mb-3 overflow-hidden">
        <CardHeader title={t.report.collectorWise} description={formatDateLong(date)} />
        {rows.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title={t.report.noResults}
            description="No payments were recorded on this date."
          />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>{t.submission.collector}</TH>
                  <TH align="right">{t.report.collectionCount}</TH>
                  <TH align="right">{t.report.totalCollected}</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.collector_id}>
                    <TD className="font-medium">{row.collector_name}</TD>
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
                  {count}
                </TD>
                <TD align="right" numeric>
                  {formatCurrency(total)}
                </TD>
              </TFootRow>
            </Table>
          </TableWrap>
        )}
      </Card>

      <h2 className="mb-2 px-1 text-sm font-semibold text-ink-soft">
        {t.payment.many} · {formatDateLong(date)}
      </h2>
      <PaymentsTable
        payments={payments.payments}
        page={payments.page}
        pageCount={payments.pageCount}
        total={payments.total}
        sum={payments.sum}
        canVoid
        emptyDescription="No payments were recorded on this date."
      />
    </>
  );
}

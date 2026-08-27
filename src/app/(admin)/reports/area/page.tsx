import type { Metadata } from "next";
import Link from "next/link";
import { Map as MapIcon } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
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
import { FilterBar, UrlSelect } from "@/components/filters/url-controls";
import { getAreaSummary } from "@/lib/queries/areas";
import { dhakaCurrentMonth, formatCurrency, formatMonth, monthOptions, toMonthStart } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Area Report" };

export default async function AreaReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const month = params.month ? toMonthStart(params.month) : dhakaCurrentMonth();
  const rows = await getAreaSummary(month);

  // Only areas that actually have clients this month are worth a row.
  const active = rows.filter((row) => row.clientCount > 0);

  const totals = active.reduce(
    (acc, row) => ({
      clients: acc.clients + row.clientCount,
      original: acc.original + row.originalAmount,
      adjustment: acc.adjustment + row.adjustmentAmount,
      adjusted: acc.adjusted + row.adjustedAmount,
      collected: acc.collected + row.collectedAmount,
      due: acc.due + row.dueAmount,
    }),
    { clients: 0, original: 0, adjustment: 0, adjusted: 0, collected: 0, due: 0 },
  );

  return (
    <>
      <PageHeader
        title={t.area.summary}
        description={`${formatMonth(month)} · ${t.area.summaryDescription}`}
      />

      <FilterBar>
        <UrlSelect
          param="month"
          value={month}
          label={t.common.month}
          options={monthOptions(18)}
          className="w-full sm:w-56"
        />
      </FilterBar>

      <div className="mb-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label={t.bill.originalBill} value={formatCurrency(totals.original)} />
        <StatCard
          label={t.bill.adjustment}
          value={formatCurrency(totals.adjustment)}
          tone={totals.adjustment > 0 ? "brand" : "default"}
        />
        <StatCard
          label={t.report.totalCollected}
          value={formatCurrency(totals.collected)}
          tone="positive"
        />
        <StatCard
          label={t.report.totalDue}
          value={formatCurrency(totals.due)}
          tone={totals.due > 0 ? "danger" : "positive"}
        />
      </div>

      <Card className="overflow-hidden">
        {active.length === 0 ? (
          <EmptyState
            icon={MapIcon}
            title={t.report.noResults}
            description="No area has billed clients for this month yet."
            action={
              <Link
                href="/areas"
                className="inline-flex h-9 items-center rounded-xl bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
              >
                {t.area.many}
              </Link>
            }
          />
        ) : (
          <>
            {/* Mobile */}
            <div className="sm:hidden">
              {active.map((row) => (
                <MobileCard key={row.areaId ?? "unassigned"}>
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{row.areaName}</p>
                      <p className="text-xs text-ink-faint">
                        {row.clientCount} {t.area.clients.toLowerCase()}
                      </p>
                    </div>
                    <span className="tnum text-base font-semibold text-danger">
                      {formatCurrency(row.dueAmount)}
                    </span>
                  </div>
                  <MobileField
                    label={t.bill.originalBill}
                    value={formatCurrency(row.originalAmount)}
                  />
                  {row.adjustmentAmount > 0 && (
                    <MobileField
                      label={t.bill.adjustment}
                      value={
                        <span className="text-brand-700">
                          − {formatCurrency(row.adjustmentAmount)}
                        </span>
                      }
                    />
                  )}
                  <MobileField
                    label={t.bill.adjustedBill}
                    value={formatCurrency(row.adjustedAmount)}
                  />
                  <MobileField
                    label={t.report.totalCollected}
                    value={formatCurrency(row.collectedAmount)}
                  />
                  <div className="mt-2 flex items-center gap-1.5 text-xs">
                    <Badge tone="positive">{row.paidCount} paid</Badge>
                    <Badge tone="warning">{row.partialCount} partial</Badge>
                    <Badge tone="danger">{row.unpaidCount} unpaid</Badge>
                  </div>
                  {row.areaId && (
                    <Link
                      href={`/clients?area=${row.areaId}`}
                      className="mt-2 inline-block text-xs font-medium text-brand-700"
                    >
                      View clients
                    </Link>
                  )}
                </MobileCard>
              ))}
            </div>

            {/* Desktop */}
            <TableWrap className="hidden sm:block">
              <Table>
                <THead>
                  <TR>
                    <TH>{t.area.one}</TH>
                    <TH align="right">{t.area.clients}</TH>
                    <TH align="right">{t.bill.originalBill}</TH>
                    <TH align="right">{t.bill.adjustment}</TH>
                    <TH align="right">{t.bill.adjustedBill}</TH>
                    <TH align="right">{t.report.totalCollected}</TH>
                    <TH align="right">{t.report.totalDue}</TH>
                    <TH align="center">Paid / Partial / Unpaid</TH>
                  </TR>
                </THead>
                <TBody>
                  {active.map((row) => (
                    <TR key={row.areaId ?? "unassigned"}>
                      <TD className="font-medium">
                        {row.areaId ? (
                          <Link
                            href={`/clients?area=${row.areaId}`}
                            className="text-brand-700 hover:underline"
                          >
                            {row.areaName}
                          </Link>
                        ) : (
                          <Link href="/clients?area=none" className="text-ink-soft hover:underline">
                            {row.areaName}
                          </Link>
                        )}
                        {!row.isActive && (
                          <span className="ml-1.5 text-xs text-ink-faint">({t.area.inactive})</span>
                        )}
                      </TD>
                      <TD align="right" numeric>
                        {row.clientCount}
                      </TD>
                      <TD align="right" numeric>
                        {formatCurrency(row.originalAmount)}
                      </TD>
                      <TD
                        align="right"
                        numeric
                        className={row.adjustmentAmount > 0 ? "text-brand-700" : "text-ink-faint"}
                      >
                        {row.adjustmentAmount > 0
                          ? `− ${formatCurrency(row.adjustmentAmount)}`
                          : formatCurrency(0)}
                      </TD>
                      <TD align="right" numeric className="font-medium">
                        {formatCurrency(row.adjustedAmount)}
                      </TD>
                      <TD align="right" numeric className="text-positive">
                        {formatCurrency(row.collectedAmount)}
                      </TD>
                      <TD
                        align="right"
                        numeric
                        className={row.dueAmount > 0 ? "font-semibold text-danger" : undefined}
                      >
                        {formatCurrency(row.dueAmount)}
                      </TD>
                      <TD align="center" numeric className="text-ink-soft">
                        {row.paidCount} / {row.partialCount} / {row.unpaidCount}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFootRow>
                  <TD>{t.report.grandTotal}</TD>
                  <TD align="right" numeric>
                    {totals.clients}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(totals.original)}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(totals.adjustment)}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(totals.adjusted)}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(totals.collected)}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(totals.due)}
                  </TD>
                  <TD />
                </TFootRow>
              </Table>
            </TableWrap>
          </>
        )}
      </Card>

      <p className="mt-3 px-1 text-xs text-ink-faint">
        Clients without an area are reported under &ldquo;{t.area.unassigned}&rdquo;, so the area
        totals always add up to the business totals.
      </p>
    </>
  );
}

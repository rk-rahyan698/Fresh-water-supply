import type { Metadata } from "next";
import Link from "next/link";
import { FileWarning, Phone } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { BillStatusBadge } from "@/components/ui/badge";
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
import { FilterBar, UrlSearchInput, UrlSelect } from "@/components/filters/url-controls";
import { AdjustmentNote } from "@/components/bills/bill-summary";
import { getDueReport, type DueSort } from "@/lib/queries/reports";
import { listAreas } from "@/lib/queries/areas";
import { formatCurrency, formatMonth, monthOptions, toMonthStart } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Due Report" };

const SORT_OPTIONS = [
  { value: "highest", label: t.report.sortHighest },
  { value: "oldest", label: t.report.sortOldest },
];

const MIN_DUE_OPTIONS = [
  { value: "", label: `${t.common.all} amounts` },
  { value: "100", label: "৳100+" },
  { value: "500", label: "৳500+" },
  { value: "1000", label: "৳1,000+" },
  { value: "5000", label: "৳5,000+" },
];

export default async function DueReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; q?: string; min?: string; sort?: string; area?: string }>;
}) {
  const params = await searchParams;
  const billingMonth = params.month ? toMonthStart(params.month) : "all";
  const sort = (params.sort as DueSort) ?? "highest";
  const minDue = params.min ? Number(params.min) : undefined;

  const [areas, { rows, totalDue, count, clientCount, truncated }] = await Promise.all([
    listAreas(),
    getDueReport({
      billingMonth,
      search: params.q,
      areaId: params.area || undefined,
      minDue,
      sort,
    }),
  ]);

  // clientCount comes from the aggregate, not from `rows` - the list is capped,
  // and counting distinct clients across a capped list undercounts them.

  return (
    <>
      <PageHeader title={t.report.due} description={t.report.dueDescription} />

      <FilterBar
        alwaysVisible={
          <UrlSearchInput
            initialValue={params.q ?? ""}
            placeholder={t.client.searchPlaceholder}
            className="min-w-0 flex-1"
          />
        }
      >
        <UrlSelect
          param="month"
          value={billingMonth === "all" ? "" : billingMonth}
          label={t.common.month}
          options={[{ value: "", label: `${t.common.all} months` }, ...monthOptions(18)]}
          className="w-full sm:w-44"
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
        <UrlSelect
          param="min"
          value={params.min ?? ""}
          label={t.report.minDue}
          options={MIN_DUE_OPTIONS}
          className="w-full sm:w-36"
        />
        <UrlSelect
          param="sort"
          value={sort}
          label="Sort"
          options={SORT_OPTIONS}
          className="w-full sm:w-44"
        />
      </FilterBar>

      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <StatCard label={t.report.totalDue} value={formatCurrency(totalDue)} tone="danger" />
        <StatCard label="Unpaid bills" value={count} />
        <StatCard label="Clients" value={clientCount} />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={FileWarning}
            title={t.report.noResults}
            description="Nothing is outstanding for this selection - everything has been collected."
          />
        ) : (
          <>
            <div className="sm:hidden">
              {rows.map((row) => (
                <MobileCard key={row.id}>
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <Link
                      href={`/clients/${row.client_id}`}
                      className="min-w-0 text-sm font-medium text-brand-700"
                    >
                      <span className="block truncate">{row.clients?.name ?? "-"}</span>
                      <span className="block text-xs font-normal text-ink-faint">
                        {row.clients?.client_code} · {formatMonth(row.billing_month)}
                      </span>
                    </Link>
                    <span className="tnum text-base font-semibold text-danger">
                      {formatCurrency(row.due_amount)}
                    </span>
                  </div>
                  <MobileField
                    label={t.bill.adjustedBill}
                    value={formatCurrency(row.adjusted_amount)}
                  />
                  {Number(row.adjustment_amount) > 0 && (
                    <MobileField
                      label={t.bill.adjustment}
                      value={
                        <span className="text-brand-700">
                          − {formatCurrency(row.adjustment_amount)}
                        </span>
                      }
                    />
                  )}
                  <MobileField label={t.bill.paid} value={formatCurrency(row.paid_amount)} />
                  {row.clients?.phone && (
                    <a
                      href={`tel:${row.clients.phone}`}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700"
                    >
                      <Phone className="size-3.5" />
                      {row.clients.phone}
                    </a>
                  )}
                </MobileCard>
              ))}
            </div>

            <TableWrap className="hidden sm:block">
              <Table>
                <THead>
                  <TR>
                    <TH>{t.client.one}</TH>
                    <TH>{t.client.phone}</TH>
                    <TH>{t.bill.billingMonth}</TH>
                    <TH align="right">{t.bill.adjustedBill}</TH>
                    <TH align="right">{t.bill.paid}</TH>
                    <TH align="right">{t.bill.due}</TH>
                    <TH>{t.bill.status}</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD>
                        <Link
                          href={`/clients/${row.client_id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {row.clients?.name ?? "-"}
                        </Link>
                        <span className="block text-xs text-ink-faint">
                          {row.clients?.client_code}
                        </span>
                      </TD>
                      <TD className="text-ink-soft">
                        {row.clients?.phone ? (
                          <a href={`tel:${row.clients.phone}`} className="hover:text-brand-600">
                            {row.clients.phone}
                          </a>
                        ) : (
                          "-"
                        )}
                      </TD>
                      <TD className="whitespace-nowrap">{formatMonth(row.billing_month)}</TD>
                      <TD align="right" numeric>
                        {formatCurrency(row.adjusted_amount)}
                        <AdjustmentNote bill={row} />
                      </TD>
                      <TD align="right" numeric className="text-positive">
                        {formatCurrency(row.paid_amount)}
                      </TD>
                      <TD align="right" numeric className="font-semibold text-danger">
                        {formatCurrency(row.due_amount)}
                      </TD>
                      <TD>
                        <BillStatusBadge status={row.status} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFootRow>
                  <TD>{t.report.grandTotal}</TD>
                  <TD />
                  <TD />
                  <TD />
                  <TD />
                  <TD align="right" numeric>
                    {formatCurrency(totalDue)}
                  </TD>
                  <TD />
                </TFootRow>
              </Table>
            </TableWrap>

            {/* The totals above describe every outstanding bill; the list is
                capped. Say so, rather than letting the rows appear not to add
                up to the grand total. */}
            {truncated && (
              <p className="border-t border-line px-4 py-3 text-xs text-ink-soft">
                Showing the {rows.length} largest of {count} unpaid bills. The
                totals above cover all {count}. Narrow the filters to see the rest.
              </p>
            )}
          </>
        )}
      </Card>
    </>
  );
}

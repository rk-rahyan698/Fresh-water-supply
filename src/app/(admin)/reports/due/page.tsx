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
import { getDueReport, type DueSort } from "@/lib/queries/reports";
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
  searchParams: Promise<{ month?: string; q?: string; min?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const billingMonth = params.month ? toMonthStart(params.month) : "all";
  const sort = (params.sort as DueSort) ?? "highest";
  const minDue = params.min ? Number(params.min) : undefined;

  const { rows, totalDue, count } = await getDueReport({
    billingMonth,
    search: params.q,
    minDue,
    sort,
  });

  const clientsAffected = new Set(rows.map((row) => row.client_id)).size;

  return (
    <>
      <PageHeader title={t.report.due} description={t.report.dueDescription} />

      <FilterBar>
        <UrlSelect
          param="month"
          value={billingMonth === "all" ? "" : billingMonth}
          label={t.common.month}
          options={[{ value: "", label: `${t.common.all} months` }, ...monthOptions(18)]}
          className="w-full sm:w-44"
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
        <UrlSearchInput
          initialValue={params.q ?? ""}
          placeholder={t.client.searchPlaceholder}
          className="min-w-0 flex-1"
        />
      </FilterBar>

      <div className="mb-3 grid grid-cols-3 gap-2.5">
        <StatCard label={t.report.totalDue} value={formatCurrency(totalDue)} tone="danger" />
        <StatCard label="Unpaid bills" value={count} />
        <StatCard label="Clients" value={clientsAffected} />
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
                  <MobileField label={t.bill.amount} value={formatCurrency(row.bill_amount)} />
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
                    <TH align="right">{t.bill.amount}</TH>
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
                        {formatCurrency(row.bill_amount)}
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
          </>
        )}
      </Card>
    </>
  );
}

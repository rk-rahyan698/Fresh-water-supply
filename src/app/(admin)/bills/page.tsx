import type { Metadata } from "next";
import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { BillStatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import {
  MobileCard,
  MobileField,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { GenerateBillsButton } from "@/components/bills/generate-bills-button";
import { FilterBar, UrlSearchInput, UrlSelect } from "@/components/filters/url-controls";
import { listBills } from "@/lib/queries/payments";
import { dhakaCurrentMonth, formatCurrency, formatMonth, monthOptions, toMonthStart } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { BillStatus } from "@/types/database";

export const metadata: Metadata = { title: "Bills" };

const STATUS_OPTIONS = [
  { value: "all", label: t.common.all },
  { value: "unpaid", label: t.bill.unpaid },
  { value: "partial", label: t.bill.partial },
  { value: "paid", label: t.bill.paidStatus },
];

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; status?: string; q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const month = params.month ? toMonthStart(params.month) : dhakaCurrentMonth();
  const status = (params.status as BillStatus | "all") ?? "all";
  const search = params.q ?? "";
  const page = Number(params.page ?? 1);

  const { bills, total, pageCount, totals } = await listBills({
    billingMonth: month,
    status,
    search,
    page,
  });

  return (
    <>
      <PageHeader
        title={t.bill.many}
        description={formatMonth(month)}
        action={<GenerateBillsButton defaultMonth={month} />}
      />

      <FilterBar>
        <UrlSelect
          param="month"
          value={month}
          label={t.common.month}
          options={monthOptions(18)}
          className="w-full sm:w-44"
        />
        <UrlSelect
          param="status"
          value={status}
          label={t.bill.status}
          options={STATUS_OPTIONS}
          className="w-32"
        />
        <UrlSearchInput
          initialValue={search}
          placeholder={t.client.searchPlaceholder}
          className="min-w-0 flex-1"
        />
      </FilterBar>

      <div className="mb-3 grid grid-cols-3 gap-2.5">
        <StatCard label={t.report.totalBilled} value={formatCurrency(totals.billed)} />
        <StatCard label={t.report.totalCollected} value={formatCurrency(totals.paid)} tone="positive" />
        <StatCard
          label={t.report.totalDue}
          value={formatCurrency(totals.due)}
          tone={totals.due > 0 ? "danger" : "positive"}
        />
      </div>

      <Card className="overflow-hidden">
        {bills.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title={t.bill.empty}
            description={`No bills match this filter for ${formatMonth(month)}. Generate them to get started.`}
            action={<GenerateBillsButton defaultMonth={month} />}
          />
        ) : (
          <>
            {/* Mobile */}
            <div className="sm:hidden">
              {bills.map((bill) => (
                <MobileCard key={bill.id}>
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <Link
                      href={`/clients/${bill.client_id}`}
                      className="min-w-0 text-sm font-medium text-brand-700"
                    >
                      <span className="block truncate">{bill.clients?.name ?? "-"}</span>
                      <span className="block text-xs font-normal text-ink-faint">
                        {bill.clients?.client_code}
                      </span>
                    </Link>
                    <BillStatusBadge status={bill.status} />
                  </div>
                  <MobileField label={t.bill.amount} value={formatCurrency(bill.bill_amount)} />
                  <MobileField label={t.bill.paid} value={formatCurrency(bill.paid_amount)} />
                  <MobileField
                    label={t.bill.due}
                    value={
                      <span className={Number(bill.due_amount) > 0 ? "text-danger" : "text-positive"}>
                        {formatCurrency(bill.due_amount)}
                      </span>
                    }
                  />
                </MobileCard>
              ))}
            </div>

            {/* Desktop */}
            <TableWrap className="hidden sm:block">
              <Table>
                <THead>
                  <TR>
                    <TH>{t.client.one}</TH>
                    <TH>{t.client.code}</TH>
                    <TH align="right">{t.bill.amount}</TH>
                    <TH align="right">{t.bill.paid}</TH>
                    <TH align="right">{t.bill.due}</TH>
                    <TH>{t.bill.status}</TH>
                  </TR>
                </THead>
                <TBody>
                  {bills.map((bill) => (
                    <TR key={bill.id}>
                      <TD>
                        <Link
                          href={`/clients/${bill.client_id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {bill.clients?.name ?? "-"}
                        </Link>
                      </TD>
                      <TD className="text-ink-soft">{bill.clients?.client_code}</TD>
                      <TD align="right" numeric>
                        {formatCurrency(bill.bill_amount)}
                      </TD>
                      <TD align="right" numeric className="text-positive">
                        {formatCurrency(bill.paid_amount)}
                      </TD>
                      <TD
                        align="right"
                        numeric
                        className={
                          Number(bill.due_amount) > 0 ? "font-semibold text-danger" : undefined
                        }
                      >
                        {formatCurrency(bill.due_amount)}
                      </TD>
                      <TD>
                        <BillStatusBadge status={bill.status} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>

            <div className="border-t border-line">
              <Pagination page={page} pageCount={pageCount} total={total} />
            </div>
          </>
        )}
      </Card>
    </>
  );
}

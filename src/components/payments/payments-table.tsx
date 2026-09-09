import Link from "next/link";
import { Receipt } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PaymentMethodBadge } from "@/components/ui/badge";
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
import { VoidPaymentButton } from "./void-payment-button";
import { formatCurrency, formatDate, formatMonth, formatReceiptNo } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { PaymentDetail } from "@/types/database";

/**
 * Shared collections table.
 *
 * `canVoid` is admin-only, and `showCollector` is off in the collector's own
 * view where every row is theirs anyway.
 */
export function PaymentsTable({
  payments,
  page,
  pageCount,
  total,
  sum,
  canVoid = false,
  showCollector = true,
  clientBasePath = "/clients",
  emptyDescription,
}: {
  payments: PaymentDetail[];
  page: number;
  pageCount: number;
  total: number;
  sum: number;
  canVoid?: boolean;
  showCollector?: boolean;
  /** "/clients" for admins, "/my/clients" for collectors. */
  clientBasePath?: string;
  emptyDescription?: string;
}) {
  if (payments.length === 0) {
    return (
      <Card>
        <EmptyState icon={Receipt} title={t.payment.empty} description={emptyDescription} />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* Mobile */}
      <div className="sm:hidden">
        {payments.map((payment) => {
          const voided = payment.voided_at !== null;
          return (
            <MobileCard key={payment.id} className={voided ? "bg-danger-soft/25" : undefined}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <Link
                  href={`${clientBasePath}/${payment.clients?.id ?? ""}`}
                  className="min-w-0 text-sm font-medium text-brand-700"
                >
                  <span className="block truncate">{payment.clients?.name ?? "-"}</span>
                  <span className="block text-xs font-normal text-ink-faint">
                    {formatReceiptNo(payment.receipt_no)}
                  </span>
                </Link>
                <span
                  className={`tnum text-base font-semibold ${
                    voided ? "text-ink-faint line-through" : "text-ink"
                  }`}
                >
                  {formatCurrency(payment.amount)}
                </span>
              </div>
              <MobileField label={t.common.date} value={formatDate(payment.payment_date)} />
              <MobileField
                label={t.bill.billingMonth}
                value={
                  payment.monthly_bills ? formatMonth(payment.monthly_bills.billing_month) : "-"
                }
              />
              {showCollector && (
                <MobileField
                  label={t.payment.collectedBy}
                  value={payment.collector?.full_name ?? "-"}
                />
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <PaymentMethodBadge method={payment.payment_method} />
                <div className="flex items-center gap-1">
                  <Link
                    href={`/receipt/${payment.id}`}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                  >
                    {t.payment.receipt}
                  </Link>
                  {canVoid && !voided && (
                    <VoidPaymentButton
                      paymentId={payment.id}
                      receiptNo={payment.receipt_no}
                      amount={Number(payment.amount)}
                      clientName={payment.clients?.name ?? "-"}
                    />
                  )}
                </div>
              </div>
              {voided && (
                <p className="mt-1.5 text-xs text-danger">
                  {t.payment.voided}
                  {payment.void_reason ? ` · ${payment.void_reason}` : ""}
                </p>
              )}
            </MobileCard>
          );
        })}
      </div>

      {/* Desktop */}
      <TableWrap className="hidden sm:block">
        <Table>
          <THead>
            <TR>
              <TH>{t.common.date}</TH>
              <TH>{t.client.one}</TH>
              <TH>{t.bill.billingMonth}</TH>
              <TH align="right">{t.payment.amount}</TH>
              <TH>{t.payment.method}</TH>
              {showCollector && <TH>{t.payment.collectedBy}</TH>}
              <TH align="right">{t.common.actions}</TH>
            </TR>
          </THead>
          <TBody>
            {payments.map((payment) => {
              const voided = payment.voided_at !== null;
              return (
                <TR key={payment.id} className={voided ? "bg-danger-soft/25" : undefined}>
                  <TD className="whitespace-nowrap">{formatDate(payment.payment_date)}</TD>
                  <TD>
                    <Link
                      href={`${clientBasePath}/${payment.clients?.id ?? ""}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {payment.clients?.name ?? "-"}
                    </Link>
                    <span className="block text-xs text-ink-faint">
                      {formatReceiptNo(payment.receipt_no)}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap text-ink-soft">
                    {payment.monthly_bills ? formatMonth(payment.monthly_bills.billing_month) : "-"}
                  </TD>
                  <TD
                    align="right"
                    numeric
                    className={
                      voided ? "font-semibold text-ink-faint line-through" : "font-semibold"
                    }
                  >
                    {formatCurrency(payment.amount)}
                  </TD>
                  <TD>
                    <PaymentMethodBadge method={payment.payment_method} />
                  </TD>
                  {showCollector && (
                    <TD className="text-ink-soft">{payment.collector?.full_name ?? "-"}</TD>
                  )}
                  <TD align="right">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/receipt/${payment.id}`}
                        className="rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                      >
                        {t.payment.receipt}
                      </Link>
                      {canVoid && !voided && (
                        <VoidPaymentButton
                          paymentId={payment.id}
                          receiptNo={payment.receipt_no}
                          amount={Number(payment.amount)}
                          clientName={payment.clients?.name ?? "-"}
                        />
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </TableWrap>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <span className="text-sm font-medium text-ink">
          {t.report.totalCollected}:{" "}
          <span className="tnum font-semibold">{formatCurrency(sum)}</span>
        </span>
        <span className="text-xs text-ink-faint">across all {total} filtered records</span>
      </div>
      <div className="border-t border-line">
        <Pagination page={page} pageCount={pageCount} total={total} />
      </div>
    </Card>
  );
}

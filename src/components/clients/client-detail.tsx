"use client";

import { Phone, MapPin, Calendar, Hash, Map as MapIcon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { BillStatusBadge, ClientStatusBadge, PaymentMethodBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CollectPaymentButton } from "@/components/payments/collect-payment-dialog";
import { BillFinancialSummary } from "@/components/bills/bill-summary";
import { BillAdjustmentButton } from "@/components/bills/bill-adjustment-dialog";
import { formatCurrency, formatDate, formatMonth, formatReceiptNo } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Client, MonthlyBill } from "@/types/database";
import type { ClientPayment } from "@/lib/queries/clients";

/* -------------------------------------------------------------------------- */
/* Identity + contact                                                          */
/* -------------------------------------------------------------------------- */

export function ClientSummaryCard({
  client,
  outstanding,
  actions,
  areaName,
}: {
  client: Client;
  outstanding: number;
  actions?: React.ReactNode;
  /** Area label for the profile header (spec sections 3, 25). */
  areaName?: string | null;
}) {
  return (
    <Card>
      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-ink">{client.name}</h2>
              <ClientStatusBadge status={client.status} />
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
              <Hash className="size-3.5" />
              {client.client_code}
            </p>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Detail label={t.client.monthlyBill} value={formatCurrency(client.monthly_bill)} strong />
          <Detail
            label={t.client.totalDue}
            value={formatCurrency(outstanding)}
            strong
            tone={outstanding > 0 ? "danger" : "positive"}
          />
          <Detail
            label={t.client.phone}
            value={
              client.phone ? (
                // tel: makes the number tappable, which is the point on a phone.
                <a href={`tel:${client.phone}`} className="text-brand-600 hover:underline">
                  {client.phone}
                </a>
              ) : (
                "-"
              )
            }
            icon={Phone}
          />
          <Detail label={t.client.startDate} value={formatDate(client.start_date)} icon={Calendar} />
          <Detail
            label={t.area.one}
            value={areaName ?? <span className="text-ink-faint">{t.area.none}</span>}
            icon={MapIcon}
          />
          {client.address && (
            <Detail
              label={t.client.address}
              value={client.address}
              icon={MapPin}
              className="col-span-2 sm:col-span-4"
            />
          )}
          {client.notes && (
            <Detail label={t.client.notes} value={client.notes} className="col-span-2 sm:col-span-4" />
          )}
        </dl>
      </div>
    </Card>
  );
}

function Detail({
  label,
  value,
  icon: Icon,
  strong,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  strong?: boolean;
  tone?: "danger" | "positive";
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="flex items-center gap-1 text-xs font-medium text-ink-faint">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </dt>
      <dd
        className={[
          "mt-0.5 text-sm break-words",
          strong ? "tnum text-base font-semibold" : "text-ink",
          tone === "danger" ? "text-danger" : tone === "positive" ? "text-positive" : "text-ink",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The current month's bill - the collector's main target                      */
/* -------------------------------------------------------------------------- */

export function CurrentBillCard({
  client,
  bill,
  billingMonth,
  canCollect,
  adminAction,
  adjustmentAction,
  approvedBy,
}: {
  client: Client;
  bill: MonthlyBill | null;
  billingMonth: string;
  canCollect: boolean;
  adminAction?: React.ReactNode;
  /** Admin-only "Add adjustment" control. */
  adjustmentAction?: React.ReactNode;
  approvedBy?: string | null;
}) {
  if (!bill) {
    return (
      <Card>
        <CardHeader title={formatMonth(billingMonth)} />
        <EmptyState
          title={t.bill.noBillForMonth}
          description={adminAction ? undefined : t.bill.askAdmin}
          action={adminAction}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={formatMonth(bill.billing_month)}
        description={t.bill.one}
        action={<BillStatusBadge status={bill.status} />}
      />
      <div className="px-4 py-4 sm:px-5">
        {/* Full ladder so a waived bill never reads like an underpaid one. */}
        <BillFinancialSummary bill={bill} approvedBy={approvedBy} />

        <div className="mt-4 space-y-2">
          {canCollect && (
            <CollectPaymentButton
              clientId={client.id}
              clientName={client.name}
              bill={bill}
              size="lg"
              fullWidth
            />
          )}
          {adjustmentAction}
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Bill history                                                                */
/* -------------------------------------------------------------------------- */

export function BillHistoryCard({
  client,
  bills,
  canCollect,
  canAdjust = false,
}: {
  client: Client;
  bills: MonthlyBill[];
  canCollect: boolean;
  /**
   * Admin-only per-row adjustment control.
   *
   * A boolean, not a render function: this is a Client Component, and a
   * function prop cannot cross the server -> client boundary. The button is
   * imported and rendered here instead.
   */
  canAdjust?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t.client.billHistory} description={`${bills.length} months`} />
      {bills.length === 0 ? (
        <EmptyState title={t.bill.empty} description="Bills appear here once they are generated." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>{t.bill.billingMonth}</TH>
                <TH align="right">{t.bill.originalBill}</TH>
                <TH align="right">{t.bill.adjustment}</TH>
                <TH align="right">{t.bill.adjustedBill}</TH>
                <TH align="right">{t.bill.paid}</TH>
                <TH align="right">{t.bill.due}</TH>
                <TH>{t.bill.status}</TH>
                {(canCollect || canAdjust) && <TH />}
              </TR>
            </THead>
            <TBody>
              {bills.map((bill) => (
                <TR key={bill.id}>
                  <TD className="font-medium whitespace-nowrap">{formatMonth(bill.billing_month)}</TD>
                  <TD align="right" numeric>
                    {formatCurrency(bill.bill_amount)}
                  </TD>
                  <TD align="right" numeric>
                    {Number(bill.adjustment_amount) > 0 ? (
                      <span className="text-brand-700">
                        − {formatCurrency(bill.adjustment_amount)}
                      </span>
                    ) : (
                      <span className="text-ink-faint">{formatCurrency(0)}</span>
                    )}
                  </TD>
                  <TD align="right" numeric className="font-medium">
                    {formatCurrency(bill.adjusted_amount)}
                  </TD>
                  <TD align="right" numeric className="text-positive">
                    {formatCurrency(bill.paid_amount)}
                  </TD>
                  <TD
                    align="right"
                    numeric
                    className={Number(bill.due_amount) > 0 ? "font-semibold text-danger" : undefined}
                  >
                    {formatCurrency(bill.due_amount)}
                  </TD>
                  <TD>
                    <BillStatusBadge status={bill.status} />
                  </TD>
                  {(canCollect || canAdjust) && (
                    <TD align="right">
                      <div className="flex items-center justify-end gap-1.5">
                        {canAdjust && (
                          <BillAdjustmentButton bill={bill} clientName={client.name} />
                        )}
                        {canCollect && Number(bill.due_amount) > 0 && (
                          <CollectPaymentButton
                            clientId={client.id}
                            clientName={client.name}
                            bill={bill}
                            size="sm"
                          />
                        )}
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Payment history                                                             */
/* -------------------------------------------------------------------------- */

export function PaymentHistoryCard({
  payments,
  scopedToSelf,
  action,
}: {
  payments: ClientPayment[];
  /** Collectors only ever see their own payments - say so rather than look empty. */
  scopedToSelf?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t.client.paymentHistory}
        description={scopedToSelf ? t.payment.onlyYours : `${payments.length} transactions`}
        action={action}
      />
      {payments.length === 0 ? (
        <EmptyState title={t.payment.empty} />
      ) : (
        <ul className="divide-y divide-line">
          {payments.map((payment) => {
            const voided = payment.voided_at !== null;
            return (
              <li
                key={payment.id}
                className={`px-4 py-3 sm:px-5 ${voided ? "bg-danger-soft/25" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      {formatDate(payment.payment_date)}
                      <PaymentMethodBadge method={payment.payment_method} />
                      {voided && (
                        <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-semibold text-danger">
                          {t.payment.voided}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-soft">
                      {formatReceiptNo(payment.receipt_no)}
                      {payment.monthly_bills
                        ? ` · ${formatMonth(payment.monthly_bills.billing_month)}`
                        : ""}
                      {payment.collector ? ` · ${payment.collector.full_name}` : ""}
                    </p>
                    {payment.notes && (
                      <p className="mt-1 text-xs text-ink-faint italic">{payment.notes}</p>
                    )}
                    {voided && payment.void_reason && (
                      <p className="mt-1 text-xs text-danger">
                        {t.payment.voidReason}: {payment.void_reason}
                      </p>
                    )}
                  </div>
                  <p
                    className={`tnum shrink-0 text-sm font-semibold ${
                      voided ? "text-ink-faint line-through" : "text-ink"
                    }`}
                  >
                    {formatCurrency(payment.amount)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

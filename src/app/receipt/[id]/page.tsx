import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Droplets, CheckCircle2 } from "lucide-react";
import { ReceiptActions } from "@/components/payments/print-button";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth";
import { getPaidBefore, getPaymentReceipt } from "@/lib/queries/payments";
import { env } from "@/lib/env";
import {
  formatCurrencyExact,
  formatDate,
  formatDateTime,
  formatMonth,
  formatReceiptNo,
} from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireUser();

  // RLS means a collector can only ever load a receipt for their own payment.
  const payment = await getPaymentReceipt(id);
  if (!payment) notFound();

  const billAmount = Number(payment.monthly_bills?.bill_amount ?? 0);
  const thisPayment = Number(payment.amount);

  // Figures as they stood at this transaction, not as they stand today - a
  // printed receipt must not change meaning when a later payment is recorded.
  const previouslyPaid = await getPaidBefore(payment.monthly_bill_id, payment.id);
  const remainingDue = Math.max(billAmount - previouslyPaid - thisPayment, 0);

  const backHref = ctx.profile.role === "admin" ? "/collections" : "/my/collections";
  const voided = payment.voided_at !== null;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-3 py-5 sm:px-4">
      <ReceiptActions backHref={backHref} />

      <div className="print-area overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        {/* Header */}
        <div className="border-b border-dashed border-line px-5 py-5 text-center">
          <div className="mx-auto mb-2 flex size-11 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Droplets className="size-6" />
          </div>
          <h1 className="text-lg font-semibold text-ink">{env.businessName}</h1>
          <p className="mt-0.5 text-xs text-ink-soft">{t.payment.receipt}</p>
        </div>

        {voided && (
          <div className="border-b border-line bg-danger-soft px-5 py-3 text-center">
            <Badge tone="danger">{t.payment.voided}</Badge>
            {payment.void_reason && (
              <p className="mt-1.5 text-xs text-danger">{payment.void_reason}</p>
            )}
          </div>
        )}

        {/* The number that matters */}
        <div className="border-b border-line px-5 py-5 text-center">
          <p className="text-xs tracking-wide text-ink-soft uppercase">{t.payment.thisPayment}</p>
          <p
            className={`mt-1 text-3xl font-semibold tracking-tight ${
              voided ? "text-ink-faint line-through" : "text-positive"
            }`}
          >
            {formatCurrencyExact(thisPayment)}
          </p>
          {!voided && (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-positive">
              <CheckCircle2 className="size-3.5" />
              Received
            </p>
          )}
        </div>

        {/* Details */}
        <dl className="divide-y divide-line px-5">
          <Row label={t.payment.receiptNo} value={formatReceiptNo(payment.receipt_no)} mono />
          <Row label={t.client.name} value={payment.clients?.name ?? "-"} />
          <Row label={t.client.code} value={payment.clients?.client_code ?? "-"} />
          {payment.clients?.phone && <Row label={t.client.phone} value={payment.clients.phone} />}
          {payment.clients?.address && (
            <Row label={t.client.address} value={payment.clients.address} />
          )}
          <Row
            label={t.bill.billingMonth}
            value={
              payment.monthly_bills ? formatMonth(payment.monthly_bills.billing_month) : "-"
            }
          />
          <Row label={t.bill.amount} value={formatCurrencyExact(billAmount)} />
          <Row label={t.payment.previousPaid} value={formatCurrencyExact(previouslyPaid)} />
          <Row label={t.payment.thisPayment} value={formatCurrencyExact(thisPayment)} strong />
          <Row
            label={t.payment.remainingDue}
            value={formatCurrencyExact(remainingDue)}
            strong
            tone={remainingDue > 0 ? "danger" : "positive"}
          />
          <Row label={t.payment.method} value={methodLabel(payment.payment_method)} />
          <Row label={t.payment.date} value={formatDate(payment.payment_date)} />
          <Row label={t.payment.collectedBy} value={payment.collector?.full_name ?? "-"} />
          {payment.notes && <Row label={t.common.notes} value={payment.notes} />}
        </dl>

        {/* Footer */}
        <div className="border-t border-dashed border-line px-5 py-4 text-center">
          <p className="text-xs text-ink-faint">
            Recorded {formatDateTime(payment.created_at)} (Asia/Dhaka)
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Thank you. Please keep this receipt for your records.
          </p>
        </div>
      </div>
    </main>
  );
}

function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: t.payment.cash,
    bank: t.payment.bank,
    mobile_banking: t.payment.mobileBanking,
    other: t.payment.other,
  };
  return labels[method] ?? method;
}

function Row({
  label,
  value,
  strong,
  mono,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
  tone?: "danger" | "positive";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd
        className={[
          "tnum text-right text-sm",
          strong ? "font-semibold" : "font-medium",
          mono ? "font-mono text-xs" : "",
          tone === "danger" ? "text-danger" : tone === "positive" ? "text-positive" : "text-ink",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

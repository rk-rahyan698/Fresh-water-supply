import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Droplets, CheckCircle2 } from "lucide-react";
import { ReceiptActions } from "@/components/payments/print-button";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth";
import { getCollectionReceipt, getPaymentReceipt, type ReceiptLine } from "@/lib/queries/payments";
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

  // Every month this collection paid, with figures as they stood when it was
  // recorded - a printed receipt must not change meaning when a later payment
  // is recorded. An ordinary single payment is one line.
  const lines = await getCollectionReceipt(id);
  if (lines.length === 0) notFound();

  const valid = lines.filter((line) => !line.voided);
  const allVoided = valid.length === 0;
  const multi = lines.length > 1;
  // Voided lines stay on the receipt, struck through, but are not money received.
  const total = (allVoided ? lines : valid).reduce((sum, line) => sum + line.amount, 0);
  const remaining = valid.reduce((sum, line) => sum + line.remainingDue, 0);

  const backHref = ctx.profile.role === "admin" ? "/collections" : "/my/collections";

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

        {allVoided && (
          <div className="border-b border-line bg-danger-soft px-5 py-3 text-center">
            <Badge tone="danger">{t.payment.voided}</Badge>
            {lines[0].voidReason && (
              <p className="mt-1.5 text-xs text-danger">{lines[0].voidReason}</p>
            )}
          </div>
        )}

        {/* The number that matters */}
        <div className="border-b border-line px-5 py-5 text-center">
          <p className="text-xs tracking-wide text-ink-soft uppercase">
            {multi ? t.payment.totalReceived : t.payment.thisPayment}
          </p>
          <p
            className={`mt-1 text-3xl font-semibold tracking-tight ${
              allVoided ? "text-ink-faint line-through" : "text-positive"
            }`}
          >
            {formatCurrencyExact(total)}
          </p>
          {!allVoided && (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-positive">
              <CheckCircle2 className="size-3.5" />
              Received{multi ? ` · ${lines.length} months` : ""}
            </p>
          )}
        </div>

        {/* Details */}
        <dl className="divide-y divide-line px-5">
          <Row
            label={t.payment.receiptNo}
            value={lines.map((line) => formatReceiptNo(line.receiptNo)).join(", ")}
            mono
          />
          <Row label={t.client.name} value={payment.clients?.name ?? "-"} />
          <Row label={t.client.code} value={payment.clients?.client_code ?? "-"} />
          {payment.clients?.phone && <Row label={t.client.phone} value={payment.clients.phone} />}
          {payment.clients?.address && (
            <Row label={t.client.address} value={payment.clients.address} />
          )}

          {multi ? (
            <MonthBreakdown lines={lines} remaining={remaining} />
          ) : (
            <SingleLine line={lines[0]} />
          )}

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

/** One month: the full ladder, with the adjustment when there is one. */
function SingleLine({ line }: { line: ReceiptLine }) {
  return (
    <>
      <Row label={t.bill.billingMonth} value={formatMonth(line.billingMonth)} />
      {line.adjustmentAmount > 0 ? (
        <>
          <Row label={t.bill.originalBill} value={formatCurrencyExact(line.billAmount)} />
          <Row label={t.bill.adjustment} value={`- ${formatCurrencyExact(line.adjustmentAmount)}`} />
          <Row label={t.bill.adjustedBill} value={formatCurrencyExact(line.adjustedAmount)} />
        </>
      ) : (
        <Row label={t.bill.amount} value={formatCurrencyExact(line.billAmount)} />
      )}
      <Row label={t.payment.previousPaid} value={formatCurrencyExact(line.previouslyPaid)} />
      <Row label={t.payment.thisPayment} value={formatCurrencyExact(line.amount)} strong />
      {!line.voided && (
        <Row
          label={t.payment.remainingDue}
          value={formatCurrencyExact(line.remainingDue)}
          strong
          tone={line.remainingDue > 0 ? "danger" : "positive"}
        />
      )}
    </>
  );
}

/** Several months: one compact block each, then what is still owed on them. */
function MonthBreakdown({ lines, remaining }: { lines: ReceiptLine[]; remaining: number }) {
  return (
    <>
      <div className="py-2.5">
        <dt className="mb-1.5 text-sm text-ink-soft">{t.payment.monthsPaid}</dt>
        <dd>
          <ul className="space-y-2">
            {lines.map((line) => (
              <li key={line.paymentId} className="rounded-lg bg-canvas px-3 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-ink">
                    {formatMonth(line.billingMonth)}
                    {line.voided && (
                      <span className="ml-2 align-middle">
                        <Badge tone="danger">{t.payment.voided}</Badge>
                      </span>
                    )}
                  </span>
                  <span
                    className={`tnum text-sm font-semibold ${
                      line.voided ? "text-ink-faint line-through" : "text-ink"
                    }`}
                  >
                    {formatCurrencyExact(line.amount)}
                  </span>
                </div>
                <p className="tnum mt-0.5 text-xs text-ink-soft">
                  {t.bill.amount} {formatCurrencyExact(line.adjustedAmount)}
                  {line.adjustmentAmount > 0 ? " (after adjustment)" : ""}
                  {line.previouslyPaid > 0
                    ? ` · paid before ${formatCurrencyExact(line.previouslyPaid)}`
                    : ""}
                  {!line.voided &&
                    (line.remainingDue > 0
                      ? ` · ${formatCurrencyExact(line.remainingDue)} ${t.payment.left}`
                      : ` · ${t.payment.cleared}`)}
                </p>
              </li>
            ))}
          </ul>
        </dd>
      </div>
      <Row
        label={t.payment.remainingDue}
        value={formatCurrencyExact(remaining)}
        strong
        tone={remaining > 0 ? "danger" : "positive"}
      />
    </>
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

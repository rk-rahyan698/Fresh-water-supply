"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, HandCoins, SlidersHorizontal } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, MoneyInput, Select, Textarea, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { recordCollectionAction } from "@/lib/actions/payments";
import {
  allocateOldestFirst,
  sumAllocations,
  type Allocation,
} from "@/lib/collection-math";
import { dhakaToday, formatCurrency, formatMonth } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { MonthlyBill, PaymentMethod } from "@/types/database";

/** Everything the collect dialog needs to show the adjusted figures. */
export type BillForCollection = Pick<
  MonthlyBill,
  | "billing_month"
  | "bill_amount"
  | "adjustment_amount"
  | "adjusted_amount"
  | "adjustment_type"
  | "paid_amount"
  | "due_amount"
>;

/** "৳1,000" -> 1000. Accepts what a person actually types or pastes. */
function parseAmount(value: string): number {
  if (value.trim() === "") return 0;
  return Number(value.replace(/[,\s৳]/g, ""));
}

const METHOD_OPTIONS = [
  { value: "cash", label: t.payment.cash },
  { value: "bank", label: t.payment.bank },
  { value: "mobile_banking", label: t.payment.mobileBanking },
  { value: "other", label: t.payment.other },
];

/**
 * Collect one amount against one or more of a client's unpaid bills.
 *
 * The common case is still one number: type what the client handed over and
 * the dialog shows how it lands, oldest month first. "Change split" exists for
 * the client who says which months they are paying.
 *
 * Every figure here is advisory. record_collection() re-reads each bill under a
 * row lock and writes all months or none, so a stale screen cannot overpay a
 * month or leave a collection half-recorded.
 */
export function CollectPaymentDialog({
  open,
  onClose,
  clientId,
  clientName,
  bills,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  /** Any order; paid-up bills are ignored. */
  bills: BillForCollection[];
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const today = dhakaToday();

  const unpaid = useMemo(
    () =>
      bills
        .filter((bill) => Number(bill.due_amount) > 0)
        .sort((a, b) => a.billing_month.localeCompare(b.billing_month)),
    [bills],
  );
  const totalDue = sumAllocations(unpaid.map((bill) => ({ amount: Number(bill.due_amount) })));
  const single = unpaid.length === 1 ? unpaid[0] : null;

  const [amount, setAmount] = useState("");
  const [customising, setCustomising] = useState(false);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [paymentDate, setPaymentDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [touched, setTouched] = useState(false);

  /* ------------------------------------------------------- the split itself */
  const received = parseAmount(amount);
  const auto = allocateOldestFirst(
    unpaid.map((bill) => ({ billing_month: bill.billing_month, due: Number(bill.due_amount) })),
    Number.isFinite(received) ? received : 0,
  );

  const customRows = unpaid.map((bill) => {
    const value = parseAmount(custom[bill.billing_month] ?? "");
    const due = Number(bill.due_amount);
    return {
      billing_month: bill.billing_month,
      amount: value,
      error: !Number.isFinite(value) || value < 0
        ? "Enter a valid amount"
        : value > due
          ? `${t.bill.due} ${formatCurrency(due)}`
          : undefined,
    };
  });

  const allocations: Allocation[] = customising
    ? customRows
        .filter((row) => Number.isFinite(row.amount) && row.amount > 0)
        .map(({ billing_month, amount: value }) => ({ billing_month, amount: value }))
    : auto.allocations;

  const total = sumAllocations(allocations);
  const allocatedTo = (month: string) =>
    allocations.find((a) => a.billing_month === month)?.amount ?? 0;

  /* ------------------------------------------------------------- validation */
  let amountError: string | undefined;
  if (!customising) {
    if (amount.trim() === "") amountError = touched ? "Enter an amount" : undefined;
    else if (!Number.isFinite(received) || received <= 0) amountError = "Enter an amount greater than zero";
    else if (auto.unallocated > 0) {
      amountError = `${t.payment.overTotalDue} ${formatCurrency(totalDue)}. ${t.payment.advanceNotAllowed}`;
    }
  }
  const customInvalid = customising && customRows.some((row) => row.error);
  const canSubmit =
    !pending && total > 0 && !amountError && !customInvalid && unpaid.length > 0;

  /* ------------------------------------------------------------ interaction */
  const startCustomising = () => {
    // Seed the per-month boxes with the split currently on screen, so switching
    // never throws away what the collector already typed.
    setCustom(
      Object.fromEntries(
        unpaid.map((bill) => {
          const value = allocatedTo(bill.billing_month);
          return [bill.billing_month, value > 0 ? String(value) : ""];
        }),
      ),
    );
    setCustomising(true);
  };

  const stopCustomising = () => {
    setAmount(total > 0 ? String(total) : "");
    setCustomising(false);
  };

  const submit = async () => {
    setTouched(true);
    setFormError(undefined);
    if (!canSubmit) return;

    const remainingAfter = sumAllocations([{ amount: totalDue }, { amount: -total }]);

    const confirmed = await confirm({
      title: t.payment.confirmTitle,
      confirmLabel: `${t.common.confirm} ${formatCurrency(total)}`,
      tone: "success",
      body: (
        <span className="block space-y-1.5">
          <strong className="block text-ink">{clientName}</strong>
          <span className="block space-y-0.5">
            {allocations.map((a) => (
              <span key={a.billing_month} className="flex justify-between gap-4">
                <span>{formatMonth(a.billing_month)}</span>
                <strong className="tnum text-ink">{formatCurrency(a.amount)}</strong>
              </span>
            ))}
          </span>
          <span className="flex justify-between gap-4 border-t border-line pt-1.5">
            <span>{t.payment.totalReceived}</span>
            <strong className="tnum text-ink">{formatCurrency(total)}</strong>
          </span>
          <span className="flex justify-between gap-4">
            <span>{t.payment.remainingDue}</span>
            <strong className="tnum text-ink">{formatCurrency(remainingAfter)}</strong>
          </span>
          <span className="mt-2 block text-ink-faint">{t.payment.confirmBody}</span>
        </span>
      ),
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await recordCollectionAction({
        client_id: clientId,
        allocations,
        payment_method: method,
        payment_date: paymentDate,
        notes: notes.trim() || undefined,
      });

      if (result.ok) {
        toast.success(`${t.payment.success} · ${formatCurrency(result.data.total)}`);
        onClose();
        // One receipt for the whole collection, however many months it covered.
        router.push(`/receipt/${result.data.paymentId}`);
      } else {
        setFormError(result.error);
      }
    });
  };

  /* ------------------------------------------------------------------ view */
  return (
    <Modal
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={t.payment.collect}
      description={
        single
          ? `${clientName} · ${formatMonth(single.billing_month)}`
          : `${clientName} · ${unpaid.length} ${t.payment.unpaidMonths}`
      }
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={pending} fullWidth className="sm:w-auto">
            {t.common.cancel}
          </Button>
          <Button
            type="submit"
            form="collect-payment-form"
            variant="success"
            loading={pending}
            disabled={unpaid.length === 0}
            fullWidth
            className="sm:w-auto"
          >
            <HandCoins className="size-4" />
            {pending
              ? t.payment.collecting
              : total > 0
                ? `${t.payment.collect} · ${formatCurrency(total)}`
                : t.payment.collect}
          </Button>
        </div>
      }
    >
      <form
        id="collect-payment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-4"
        noValidate
      >
        <FormError>{formError}</FormError>

        {unpaid.length === 0 ? (
          <p className="rounded-xl bg-canvas px-3 py-3 text-center text-sm text-ink-soft">
            {t.payment.nothingDue}
          </p>
        ) : single ? (
          <SingleBillLadder bill={single} />
        ) : (
          <div className="rounded-xl bg-canvas px-3 py-2.5 text-center">
            <p className="text-xs text-ink-soft">{t.payment.totalDue}</p>
            <p className="tnum mt-0.5 text-lg font-semibold text-danger">{formatCurrency(totalDue)}</p>
            <p className="text-xs text-ink-faint">
              {unpaid.length} {t.payment.unpaidMonths} · {formatMonth(unpaid[0].billing_month)} –{" "}
              {formatMonth(unpaid[unpaid.length - 1].billing_month)}
            </p>
          </div>
        )}

        {unpaid.length > 0 && !customising && (
          <div>
            <MoneyInput
              label={t.payment.amountReceived}
              required
              placeholder="0"
              autoFocus
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              onBlur={() => setTouched(true)}
              error={amountError}
            />
            {/* One tap for the common case: the client clears everything. */}
            {String(received) !== String(totalDue) && (
              <button
                type="button"
                onClick={() => {
                  setAmount(String(totalDue));
                  setTouched(true);
                }}
                className="mt-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
              >
                {single ? t.payment.payFull : t.payment.payAllDue} · {formatCurrency(totalDue)}
              </button>
            )}
          </div>
        )}

        {/* The split. Shown whenever there is more than one month, so nobody has
            to guess which months an amount paid. */}
        {unpaid.length > 1 && (
          <div className="rounded-xl border border-line">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{t.payment.splitTitle}</p>
                {!customising && (
                  <p className="text-xs text-ink-faint">{t.payment.splitExplainer}</p>
                )}
              </div>
              <button
                type="button"
                onClick={customising ? stopCustomising : startCustomising}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50"
              >
                <SlidersHorizontal className="size-3.5" />
                {customising ? t.payment.resetSplit : t.payment.editSplit}
              </button>
            </div>

            <ul className="divide-y divide-line">
              {unpaid.map((bill, index) => {
                const due = Number(bill.due_amount);
                const applied = allocatedTo(bill.billing_month);
                const left = sumAllocations([{ amount: due }, { amount: -applied }]);
                return (
                  <li key={bill.billing_month} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{formatMonth(bill.billing_month)}</p>
                      <p className="tnum text-xs text-ink-soft">
                        {t.bill.due} {formatCurrency(due)}
                      </p>
                    </div>

                    {customising ? (
                      <div className="w-32 shrink-0">
                        <MoneyInput
                          aria-label={`${formatMonth(bill.billing_month)} ${t.payment.amount}`}
                          placeholder="0"
                          value={custom[bill.billing_month] ?? ""}
                          onChange={(event) =>
                            setCustom((current) => ({
                              ...current,
                              [bill.billing_month]: event.target.value,
                            }))
                          }
                          error={customRows[index].error}
                        />
                      </div>
                    ) : (
                      <div className="shrink-0 text-right">
                        {applied > 0 ? (
                          <>
                            <p className="tnum text-sm font-semibold text-positive">
                              {formatCurrency(applied)}
                            </p>
                            <p className="text-xs text-ink-faint">
                              {left > 0 ? `${formatCurrency(left)} ${t.payment.left}` : t.payment.cleared}
                            </p>
                          </>
                        ) : (
                          <p className="text-sm text-ink-faint">-</p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {customising && (
              <div className="flex items-center justify-between border-t border-line px-3 py-2">
                <span className="text-sm text-ink-soft">{t.payment.totalReceived}</span>
                <span className="tnum text-sm font-semibold text-ink">{formatCurrency(total)}</span>
              </div>
            )}
          </div>
        )}

        {unpaid.length > 0 && (
          <>
            <Select
              label={t.payment.method}
              options={METHOD_OPTIONS}
              value={method}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            />

            {/* Date is today and notes are empty on almost every collection, so
                they stay out of the way. A collector on a doorstep should finish
                at Amount -> Method -> Confirm (spec section 28). */}
            {showMore ? (
              <div className="space-y-4">
                <Input
                  label={t.payment.date}
                  type="date"
                  max={today}
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
                <Textarea
                  label={t.common.notes}
                  hint={t.common.optional}
                  rows={2}
                  maxLength={300}
                  placeholder="Anything worth remembering about this payment"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowMore(true)}
                className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-line text-sm font-medium text-ink-soft transition-colors hover:bg-canvas"
              >
                <ChevronDown className="size-4" />
                Change date or add a note
              </button>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

/** The full ladder for a single bill, so a waived bill never reads as underpaid. */
function SingleBillLadder({ bill }: { bill: BillForCollection }) {
  const due = Number(bill.due_amount);
  const hasAdjustment = Number(bill.adjustment_amount ?? 0) > 0;

  return (
    <div className="rounded-xl bg-canvas px-3 py-2.5">
      {hasAdjustment ? (
        <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <Figure label={t.bill.originalBill} value={formatCurrency(bill.bill_amount)} />
          <Figure label={t.bill.adjustment} value={`- ${formatCurrency(bill.adjustment_amount)}`} tone="brand" />
          <Figure label={t.bill.paid} value={formatCurrency(bill.paid_amount)} />
          <Figure label={t.bill.due} value={formatCurrency(due)} tone="danger" />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Figure label={t.bill.amount} value={formatCurrency(bill.bill_amount)} />
          <Figure label={t.bill.paid} value={formatCurrency(bill.paid_amount)} />
          <Figure label={t.bill.due} value={formatCurrency(due)} tone="danger" />
        </div>
      )}
      {hasAdjustment && (
        <p className="mt-2 border-t border-line pt-2 text-center text-xs text-brand-700">
          {t.bill.adjustedBill}: <strong className="tnum">{formatCurrency(bill.adjusted_amount)}</strong>
        </p>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "brand";
}) {
  return (
    <div>
      <p className="text-xs text-ink-soft">{label}</p>
      <p
        className={`tnum mt-0.5 text-sm font-semibold ${
          tone === "danger" ? "text-danger" : tone === "brand" ? "text-brand-700" : "text-ink"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Button + dialog pair, so a page only needs one component.
 *
 * Pass every unpaid bill for the client-level "Collect payment", or a single
 * bill for a per-month row. Enabled whenever anything at all is due - not only
 * when the current month is, which is what used to leave arrears uncollectable.
 */
export function CollectPaymentButton({
  clientId,
  clientName,
  bills,
  size = "md",
  fullWidth,
}: {
  clientId: string;
  clientName: string;
  bills: BillForCollection[];
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const due = bills.reduce((sum, bill) => sum + Math.max(0, Number(bill.due_amount)), 0);

  return (
    <>
      <Button
        size={size}
        variant="success"
        fullWidth={fullWidth}
        disabled={due <= 0}
        onClick={() => setOpen(true)}
      >
        <HandCoins className="size-4.5" />
        {due > 0 ? t.payment.collect : t.bill.paidStatus}
      </Button>
      {open && (
        <CollectPaymentDialog
          open={open}
          onClose={() => setOpen(false)}
          clientId={clientId}
          clientName={clientName}
          bills={bills}
        />
      )}
    </>
  );
}

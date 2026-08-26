"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { HandCoins } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, MoneyInput, Select, Textarea, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { recordPaymentAction } from "@/lib/actions/payments";
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
  return Number(value.replace(/[,\s৳]/g, ""));
}

/**
 * Form-only schema. Values stay strings so the resolver's input and output
 * types match, and the numeric parse happens once in onSubmit.
 *
 * The due ceiling is checked here for instant feedback and again -
 * authoritatively, under a row lock - inside record_payment().
 */
function makeSchema(due: number) {
  return z.object({
    amount: z
      .string()
      .trim()
      .min(1, "Enter an amount")
      .refine((value) => {
        const parsed = parseAmount(value);
        return Number.isFinite(parsed) && parsed > 0;
      }, "Enter an amount greater than zero")
      .refine(
        (value) => parseAmount(value) <= due,
        `Cannot be more than the due of ${formatCurrency(due)}`,
      ),
    payment_method: z.enum(["cash", "bank", "mobile_banking", "other"]),
    payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date"),
    notes: z.string().max(300, "Note is too long").optional(),
  });
}

type FormValues = {
  amount: string;
  payment_method: PaymentMethod;
  payment_date: string;
  notes?: string;
};

const METHOD_OPTIONS = [
  { value: "cash", label: t.payment.cash },
  { value: "bank", label: t.payment.bank },
  { value: "mobile_banking", label: t.payment.mobileBanking },
  { value: "other", label: t.payment.other },
];

export function CollectPaymentDialog({
  open,
  onClose,
  clientId,
  clientName,
  bill,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  bill: BillForCollection;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | undefined>();

  const due = Number(bill.due_amount);
  const hasAdjustment = Number(bill.adjustment_amount ?? 0) > 0;
  const today = dhakaToday();

  const {
    register,
    handleSubmit,
    setValue,
    control,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(makeSchema(due)),
    defaultValues: {
      amount: "",
      payment_method: "cash",
      payment_date: today,
      notes: "",
    },
  });

  const amountValue = useWatch({ control, name: "amount" });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(undefined);

    const amount = parseAmount(values.amount);
    const remaining = due - amount;

    // Section 34: confirm before any financial write.
    const confirmed = await confirm({
      title: t.payment.confirmTitle,
      confirmLabel: `${t.common.confirm} ${formatCurrency(amount)}`,
      tone: "success",
      body: (
        <span className="block space-y-1">
          <span className="block">
            <strong className="text-ink">{clientName}</strong> ·{" "}
            {formatMonth(bill.billing_month)}
          </span>
          <span className="block">
            {t.payment.thisPayment}: <strong className="text-ink">{formatCurrency(amount)}</strong>
          </span>
          <span className="block">
            {t.payment.remainingDue}:{" "}
            <strong className="text-ink">{formatCurrency(remaining)}</strong>
          </span>
          <span className="mt-2 block text-ink-faint">{t.payment.confirmBody}</span>
        </span>
      ),
    });
    if (!confirmed) return;

    const formData = new FormData();
    formData.set("client_id", clientId);
    formData.set("billing_month", bill.billing_month);
    formData.set("amount", String(amount));
    formData.set("payment_method", values.payment_method);
    formData.set("payment_date", values.payment_date);
    if (values.notes) formData.set("notes", values.notes);

    startTransition(async () => {
      const result = await recordPaymentAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(`${t.payment.success} · ${formatCurrency(amount)}`);
        reset();
        onClose();
        // Straight to the printable receipt (section 22).
        router.push(`/receipt/${result.data.paymentId}`);
      } else {
        setFormError(result.error);
      }
    });
  });

  return (
    <Modal
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={t.payment.collect}
      description={`${clientName} · ${formatMonth(bill.billing_month)}`}
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
            fullWidth
            className="sm:w-auto"
          >
            <HandCoins className="size-4" />
            {pending ? t.payment.collecting : t.payment.collect}
          </Button>
        </div>
      }
    >
      <form id="collect-payment-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError>{formError}</FormError>

        {/* Section 14: the collector sees what is actually owed, and whether a
            discount is already applied - never just a bare "bill amount". */}
        <div className="rounded-xl bg-canvas px-3 py-2.5">
          {hasAdjustment ? (
            <div className="grid grid-cols-4 gap-2 text-center">
              <Figure label={t.bill.originalBill} value={formatCurrency(bill.bill_amount)} />
              <Figure
                label={t.bill.adjustment}
                value={`- ${formatCurrency(bill.adjustment_amount)}`}
                tone="brand"
              />
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
              {t.bill.adjustedBill}:{" "}
              <strong className="tnum">{formatCurrency(bill.adjusted_amount)}</strong>
            </p>
          )}
        </div>

        <div>
          <MoneyInput
            label={t.payment.amount}
            required
            placeholder="0"
            autoFocus
            error={errors.amount?.message}
            {...register("amount")}
          />
          {/* One tap covers the common case: the client pays the whole due. */}
          {due > 0 && String(amountValue) !== String(due) && (
            <button
              type="button"
              onClick={() => setValue("amount", String(due), { shouldValidate: true })}
              className="mt-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
            >
              {t.payment.payFull} · {formatCurrency(due)}
            </button>
          )}
        </div>

        <Select
          label={t.payment.method}
          options={METHOD_OPTIONS}
          error={errors.payment_method?.message}
          {...register("payment_method")}
        />

        <Input
          label={t.payment.date}
          type="date"
          max={today}
          error={errors.payment_date?.message}
          {...register("payment_date")}
        />

        <Textarea
          label={t.common.notes}
          hint={t.common.optional}
          rows={2}
          placeholder="Anything worth remembering about this payment"
          error={errors.notes?.message}
          {...register("notes")}
        />
      </form>
    </Modal>
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

/** Button + dialog pair, so a page only needs one component. */
export function CollectPaymentButton({
  clientId,
  clientName,
  bill,
  size = "md",
  fullWidth,
}: {
  clientId: string;
  clientName: string;
  bill: BillForCollection;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const due = Number(bill.due_amount);

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
          bill={bill}
        />
      )}
    </>
  );
}

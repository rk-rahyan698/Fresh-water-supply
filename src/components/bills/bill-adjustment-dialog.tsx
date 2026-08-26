"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Percent, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  removeBillAdjustmentAction,
  setBillAdjustmentAction,
} from "@/lib/actions/payments";
import { formatCurrency, formatMonth } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { AdjustmentType, MonthlyBill } from "@/types/database";

const TYPE_OPTIONS = [
  { value: "discount", label: t.adjustment.discount },
  { value: "waiver", label: t.adjustment.waiver },
  { value: "special_reduction", label: t.adjustment.specialReduction },
  { value: "other", label: t.adjustment.other },
];

type BillForAdjustment = Pick<
  MonthlyBill,
  | "id"
  | "billing_month"
  | "bill_amount"
  | "adjustment_amount"
  | "adjustment_type"
  | "adjustment_reason"
  | "paid_amount"
>;

/**
 * Admin-only discount / waiver on a single bill (spec sections 13 and 16).
 *
 * The ceiling shown here is `bill_amount - paid_amount`: you cannot waive money
 * that has already been collected. The SQL function enforces the same rule, so
 * this is a courtesy, not the guard.
 */
export function BillAdjustmentDialog({
  bill,
  clientName,
  open,
  onClose,
}: {
  bill: BillForAdjustment;
  clientName: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  const existing = Number(bill.adjustment_amount ?? 0);
  const [amount, setAmount] = useState(existing > 0 ? String(existing) : "");
  const [type, setType] = useState<AdjustmentType>(bill.adjustment_type ?? "discount");
  const [reason, setReason] = useState(bill.adjustment_reason ?? "");
  const [error, setError] = useState<string | undefined>();

  const original = Number(bill.bill_amount);
  const paid = Number(bill.paid_amount);
  const maxAdjustment = Math.max(original - paid, 0);

  const parsed = Number(amount.replace(/[,\s৳]/g, ""));
  const preview = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const adjustedBill = original - preview;

  const submit = () => {
    setError(undefined);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter an adjustment greater than zero.");
      return;
    }
    if (parsed > maxAdjustment) {
      setError(
        paid > 0
          ? `That would waive money already collected. The most you can adjust is ${formatCurrency(maxAdjustment)}.`
          : `An adjustment cannot be more than the bill itself (${formatCurrency(original)}).`,
      );
      return;
    }
    if (reason.trim().length < 3) {
      setError("Please give a reason for this adjustment.");
      return;
    }

    const formData = new FormData();
    formData.set("bill_id", bill.id);
    formData.set("adjustment_amount", String(parsed));
    formData.set("adjustment_type", type);
    formData.set("adjustment_reason", reason.trim());

    startTransition(async () => {
      const result = await setBillAdjustmentAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(`${t.adjustment.success} · ${formatCurrency(parsed)}`);
        onClose();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const remove = async () => {
    const confirmed = await confirm({
      title: t.adjustment.remove,
      body: t.adjustment.removeConfirm,
      confirmLabel: t.adjustment.remove,
      tone: "danger",
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await removeBillAdjustmentAction(bill.id);
      if (result.ok) {
        toast.success(t.adjustment.removed);
        onClose();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Modal
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={existing > 0 ? t.adjustment.edit : t.adjustment.add}
      description={`${clientName} · ${formatMonth(bill.billing_month)}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {existing > 0 && (
            <Button
              variant="ghost"
              onClick={remove}
              disabled={pending}
              fullWidth
              className="sm:mr-auto sm:w-auto"
            >
              <Trash2 className="size-4 text-danger" />
              {t.adjustment.remove}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={pending}
            fullWidth
            className="sm:w-auto"
          >
            {t.common.cancel}
          </Button>
          <Button onClick={submit} loading={pending} fullWidth className="sm:w-auto">
            {pending ? t.adjustment.saving : t.common.save}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <FormError>{error}</FormError>

        <p className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-ink">
          {t.adjustment.explainer}
        </p>

        <MoneyInput
          label={t.adjustment.amount}
          required
          placeholder="0"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          help={`Up to ${formatCurrency(maxAdjustment)}${paid > 0 ? ` (${formatCurrency(paid)} already collected)` : ""}`}
        />

        <Select
          label={t.adjustment.type}
          required
          value={type}
          onChange={(event) => setType(event.target.value as AdjustmentType)}
          options={TYPE_OPTIONS}
        />

        <Textarea
          label={t.adjustment.reason}
          required
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t.adjustment.reasonPlaceholder}
          help="Recorded against the bill so the reduction can be explained later."
        />

        {/* Live preview of the effect, so the owner sees the result before saving. */}
        <div className="rounded-xl bg-canvas px-3.5 py-3">
          <dl className="space-y-1.5 text-sm">
            <PreviewRow label={t.bill.originalBill} value={formatCurrency(original)} />
            <PreviewRow
              label={t.bill.adjustment}
              value={preview > 0 ? `- ${formatCurrency(preview)}` : formatCurrency(0)}
              tone={preview > 0 ? "brand" : "muted"}
            />
            <PreviewRow
              label={t.bill.adjustedBill}
              value={formatCurrency(Math.max(adjustedBill, 0))}
              strong
            />
            {paid > 0 && (
              <PreviewRow label={t.bill.paid} value={formatCurrency(paid)} tone="positive" />
            )}
            <PreviewRow
              label={t.bill.remainingDue}
              value={formatCurrency(Math.max(adjustedBill - paid, 0))}
              strong
              tone={adjustedBill - paid > 0 ? "danger" : "positive"}
            />
          </dl>
        </div>
      </div>
    </Modal>
  );
}

function PreviewRow({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "danger" | "positive" | "brand" | "muted";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={tone === "muted" ? "text-ink-faint" : "text-ink-soft"}>{label}</dt>
      <dd
        className={[
          "tnum",
          strong ? "font-semibold" : "font-medium",
          tone === "danger" ? "text-danger" : "",
          tone === "positive" ? "text-positive" : "",
          tone === "brand" ? "text-brand-700" : "",
          tone === "muted" ? "text-ink-faint" : "",
          !tone ? "text-ink" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

/** Button + dialog pair for the admin bill views. */
export function BillAdjustmentButton({
  bill,
  clientName,
  size = "sm",
}: {
  bill: BillForAdjustment;
  clientName: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const hasAdjustment = Number(bill.adjustment_amount ?? 0) > 0;

  return (
    <>
      <Button variant="secondary" size={size} onClick={() => setOpen(true)}>
        <Percent className="size-4" />
        {hasAdjustment ? t.adjustment.edit : t.adjustment.add}
      </Button>
      {open && (
        <BillAdjustmentDialog
          bill={bill}
          clientName={clientName}
          open={open}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

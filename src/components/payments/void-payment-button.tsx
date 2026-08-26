"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { voidPaymentAction } from "@/lib/actions/payments";
import { formatCurrency, formatReceiptNo } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * Voiding is the only way to undo a payment - the row is never deleted.
 * The reversal restores the client's due through the same trigger that applied
 * it, and the transaction stays visible, marked voided.
 */
export function VoidPaymentButton({
  paymentId,
  receiptNo,
  amount,
  clientName,
}: {
  paymentId: string;
  receiptNo: number;
  amount: number;
  clientName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(undefined);
    if (reason.trim().length < 3) {
      setError("Give a short reason (at least 3 characters).");
      return;
    }

    const formData = new FormData();
    formData.set("payment_id", paymentId);
    formData.set("reason", reason.trim());

    startTransition(async () => {
      const result = await voidPaymentAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(t.payment.voidSuccess);
        setOpen(false);
        setReason("");
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t.payment.void}
        title={t.payment.void}
      >
        <Ban className="size-4 text-danger" />
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.payment.void}
        description={`${formatReceiptNo(receiptNo)} · ${clientName} · ${formatCurrency(amount)}`}
        size="sm"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={pending}
              fullWidth
              className="sm:w-auto"
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={submit}
              loading={pending}
              fullWidth
              className="sm:w-auto"
            >
              {t.payment.void}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <FormError>{error}</FormError>
          <p className="rounded-xl bg-warning-soft px-3 py-2.5 text-sm text-ink">
            {t.payment.voidConfirm}
          </p>
          <Textarea
            label={t.payment.voidReason}
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Entered twice by mistake"
          />
        </div>
      </Modal>
    </>
  );
}

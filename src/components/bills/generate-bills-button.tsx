"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select, FormError } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { generateBillsAction } from "@/lib/actions/payments";
import { dhakaCurrentMonth, formatCurrency, formatMonth, monthOptions } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * Generates bills for every active client for one month.
 *
 * Re-running is safe: generate_monthly_bills() uses ON CONFLICT DO NOTHING
 * against the (client_id, billing_month) unique constraint, so a client can
 * never get two bills for the same month.
 */
export function GenerateBillsButton({ defaultMonth }: { defaultMonth?: string }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(defaultMonth ?? dhakaCurrentMonth());
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = async () => {
    setError(undefined);

    const confirmed = await confirm({
      title: `${t.bill.generateFor} ${formatMonth(month)}`,
      body: t.bill.generateConfirm,
      confirmLabel: t.bill.generate,
    });
    if (!confirmed) return;

    const formData = new FormData();
    formData.set("billing_month", month);

    startTransition(async () => {
      const result = await generateBillsAction(null, formData);
      if (!result) return;

      if (result.ok) {
        const { created, skipped, billed } = result.data;
        if (created === 0) {
          toast.info(
            `Every active client already has a ${formatMonth(month)} bill. Nothing to do.`,
          );
        } else {
          toast.success(
            `${created} ${created === 1 ? "bill" : "bills"} created for ${formatMonth(month)} · ${formatCurrency(billed)}` +
              (skipped > 0 ? ` · ${skipped} already existed` : ""),
          );
        }
        setOpen(false);
        router.push(`/bills?month=${month}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CalendarPlus className="size-4.5" />
        <span className="hidden sm:inline">{t.bill.generate}</span>
        <span className="sm:hidden">Generate</span>
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.bill.generate}
        description="Creates one bill per active client using their current monthly amount."
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
            <Button onClick={submit} loading={pending} fullWidth className="sm:w-auto">
              {pending ? t.bill.generating : t.bill.generate}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormError>{error}</FormError>
          <Select
            label={t.bill.billingMonth}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            options={monthOptions(12)}
          />
          <p className="rounded-xl bg-canvas px-3 py-2.5 text-sm text-ink-soft">
            Clients who already have a bill for {formatMonth(month)} are skipped, so running this
            twice is safe.
          </p>
        </div>
      </Modal>
    </>
  );
}

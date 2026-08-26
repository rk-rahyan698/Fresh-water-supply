"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Banknote } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { createSubmissionAction } from "@/lib/actions/submissions";
import { dhakaToday, formatCurrency } from "@/lib/format";
import { t } from "@/lib/i18n";

export interface CollectorBalance {
  id: string;
  name: string;
  cashCollected: number;
  submitted: number;
  unsubmitted: number;
}

/**
 * Records cash handed from a collector to the owner.
 *
 * The amount is capped at what the collector actually still holds -
 * create_cash_submission() enforces the same rule under a row lock, so two
 * admins cannot both accept the same cash.
 */
export function SubmissionDialog({ collectors }: { collectors: CollectorBalance[] }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [collectorId, setCollectorId] = useState(collectors[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dhakaToday());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const selected = useMemo(
    () => collectors.find((collector) => collector.id === collectorId),
    [collectors, collectorId],
  );
  const unsubmitted = selected?.unsubmitted ?? 0;

  const reset = () => {
    setAmount("");
    setNotes("");
    setDate(dhakaToday());
    setError(undefined);
  };

  const submit = async () => {
    setError(undefined);

    const parsed = Number(amount.replace(/[,\s৳]/g, ""));
    if (!collectorId) {
      setError("Select a collector.");
      return;
    }
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (parsed > unsubmitted) {
      setError(`That is more than the ${formatCurrency(unsubmitted)} this collector still holds.`);
      return;
    }

    const confirmed = await confirm({
      title: t.submission.record,
      confirmLabel: `${t.common.confirm} ${formatCurrency(parsed)}`,
      body: (
        <span className="block space-y-1">
          <span className="block">
            <strong className="text-ink">{selected?.name}</strong> {t.submission.confirmBody}
          </span>
          <span className="block">
            {t.submission.amount}: <strong className="text-ink">{formatCurrency(parsed)}</strong>
          </span>
          <span className="block">
            {t.submission.unsubmitted} after:{" "}
            <strong className="text-ink">{formatCurrency(unsubmitted - parsed)}</strong>
          </span>
        </span>
      ),
    });
    if (!confirmed) return;

    const formData = new FormData();
    formData.set("collector_id", collectorId);
    formData.set("amount", String(parsed));
    formData.set("submission_date", date);
    if (notes.trim()) formData.set("notes", notes.trim());

    startTransition(async () => {
      const result = await createSubmissionAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(`${t.submission.success} · ${formatCurrency(result.data.amount)}`);
        setOpen(false);
        reset();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={collectors.length === 0}>
        <Banknote className="size-4.5" />
        <span className="hidden sm:inline">{t.submission.record}</span>
        <span className="sm:hidden">Record</span>
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.submission.record}
        description="Record cash a collector has handed over."
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
              {pending ? t.submission.recording : t.submission.record}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormError>{error}</FormError>

          <Select
            label={t.submission.collector}
            required
            value={collectorId}
            onChange={(event) => {
              setCollectorId(event.target.value);
              setAmount("");
              setError(undefined);
            }}
            options={collectors.map((collector) => ({
              value: collector.id,
              label: `${collector.name} · ${formatCurrency(collector.unsubmitted)} held`,
            }))}
          />

          {selected && (
            <div className="grid grid-cols-3 gap-2 rounded-xl bg-canvas px-3 py-2.5 text-center">
              <Figure label={t.submission.collected} value={formatCurrency(selected.cashCollected)} />
              <Figure label={t.submission.submitted} value={formatCurrency(selected.submitted)} />
              <Figure
                label={t.submission.unsubmitted}
                value={formatCurrency(selected.unsubmitted)}
                tone="warning"
              />
            </div>
          )}

          <div>
            <MoneyInput
              label={t.submission.amount}
              required
              placeholder="0"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {unsubmitted > 0 && amount !== String(unsubmitted) && (
              <button
                type="button"
                onClick={() => setAmount(String(unsubmitted))}
                className="mt-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
              >
                {t.submission.submitAll} · {formatCurrency(unsubmitted)}
              </button>
            )}
          </div>

          <Input
            label={t.submission.date}
            type="date"
            max={dhakaToday()}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />

          <Textarea
            label={t.common.notes}
            hint={t.common.optional}
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />

          <p className="text-xs text-ink-faint">{t.submission.cashNote}</p>
        </div>
      </Modal>
    </>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div>
      <p className="text-xs text-ink-soft">{label}</p>
      <p
        className={`tnum mt-0.5 text-sm font-semibold ${
          tone === "warning" ? "text-warning" : "text-ink"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

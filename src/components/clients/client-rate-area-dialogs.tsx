"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin, TrendingUp } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { setClientAreaAction, setClientRateAction } from "@/lib/actions/areas";
import { dhakaCurrentMonth, formatCurrency, formatMonth, monthOptions, shiftMonth } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Area } from "@/types/database";

/**
 * Schedules a new monthly rate (spec sections 1, 2, 28).
 *
 * The month list starts at the current month - a rate can never be applied to
 * a month that has already been billed, which the SQL function enforces too.
 */
export function ChangeRateButton({
  clientId,
  clientName,
  currentRate,
  currentMonthBill,
}: {
  clientId: string;
  clientName: string;
  currentRate: number;
  /**
   * This month's bill, when it has already been generated.
   *
   * A rate change never rewrites a generated bill on its own, so without this
   * a mid-month increase would leave this month at the old amount while the
   * client's "Monthly bill" already showed the new one. Knowing the bill lets
   * the dialog offer to change it too - and say what happens if it does not.
   */
  currentMonthBill?: { billAmount: number; paidAmount: number } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(currentRate));
  const [effectiveFrom, setEffectiveFrom] = useState(shiftMonth(dhakaCurrentMonth(), 1));
  const [reason, setReason] = useState("");
  // Choosing "this month" means this month; the box starts ticked.
  const [rebill, setRebill] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  // Current month plus the next twelve - forward-only by design.
  const current = dhakaCurrentMonth();
  const futureMonths = Array.from({ length: 13 }, (_, i) => {
    const value = shiftMonth(current, i);
    return { value, label: formatMonth(value) + (i === 0 ? " (this month)" : "") };
  });

  const parsed = Number(amount.replace(/[,\s৳]/g, ""));

  // Only a change starting THIS month, to a month already billed at a
  // different amount, has a bill to update.
  const canRebill =
    effectiveFrom === current &&
    !!currentMonthBill &&
    Number.isFinite(parsed) &&
    parsed !== currentMonthBill.billAmount;
  const willRebill = canRebill && rebill;
  const belowPaid = willRebill && !!currentMonthBill && parsed < currentMonthBill.paidAmount;

  const submit = () => {
    setError(undefined);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (belowPaid && currentMonthBill) {
      setError(
        `This month's bill cannot be less than the ${formatCurrency(currentMonthBill.paidAmount)} already collected. Untick "${t.rate.alsoThisMonth}" to start the new amount next month.`,
      );
      return;
    }

    const formData = new FormData();
    formData.set("client_id", clientId);
    formData.set("monthly_bill", String(parsed));
    formData.set("effective_from", effectiveFrom);
    formData.set("update_current_bill", willRebill ? "true" : "false");
    if (reason.trim()) formData.set("reason", reason.trim());

    startTransition(async () => {
      const result = await setClientRateAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(
          `${t.rate.saved} · ${formatCurrency(result.data.amount)} from ${formatMonth(result.data.effectiveFrom)}` +
            (result.data.rebilled ? ", including this month's bill" : ""),
        );
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <TrendingUp className="size-4" />
        {t.rate.change}
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.rate.change}
        description={clientName}
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
              {pending ? t.common.saving : t.common.save}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormError>{error}</FormError>

          <p className="rounded-xl bg-brand-50 px-3.5 py-3 text-sm text-brand-700">
            {t.rate.explainer}
          </p>

          <div className="flex items-center justify-between rounded-xl bg-canvas px-3.5 py-2.5 text-sm">
            <span className="text-ink-soft">{t.rate.current}</span>
            <span className="tnum font-semibold text-ink">{formatCurrency(currentRate)}</span>
          </div>

          <MoneyInput
            label={t.rate.newAmount}
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
          />

          <Select
            label={t.rate.effectiveFrom}
            required
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            options={futureMonths}
            // The re-bill box below answers this for the current month, and
            // "keep their original amount" would contradict it while ticked.
            help={canRebill ? undefined : "Bills already generated keep their original amount."}
          />

          {/* A mid-month change to a month that is already billed. Directly
              under the month it depends on - NOT at the foot of the dialog.
              It is ticked by default and Save is always on screen, so on a
              phone a box below the fold would re-bill this month unseen. */}
          {canRebill && currentMonthBill && (
            <div className="rounded-xl border border-line px-3.5 py-3 text-sm">
              <p className="text-ink-soft">
                {t.rate.alreadyBilled}{" "}
                <strong className="tnum text-ink">{formatCurrency(currentMonthBill.billAmount)}</strong>.
              </p>

              <label className="mt-2.5 flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={rebill}
                  onChange={(event) => setRebill(event.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-brand-600"
                />
                <span className="font-medium text-ink">{t.rate.alsoThisMonth}</span>
              </label>

              {rebill ? (
                <p className={`mt-2 ${belowPaid ? "text-danger" : "text-ink-soft"}`}>
                  {formatMonth(current)}:{" "}
                  <span className="tnum">{formatCurrency(currentMonthBill.billAmount)}</span> →{" "}
                  <strong className="tnum text-ink">{formatCurrency(parsed)}</strong>
                  {currentMonthBill.paidAmount > 0 && (
                    <>
                      {" "}· <span className="tnum">{formatCurrency(currentMonthBill.paidAmount)}</span>{" "}
                      {t.rate.alreadyCollected}
                    </>
                  )}
                </p>
              ) : (
                <p className="mt-2 text-ink-soft">{t.rate.keepsThisMonth}</p>
              )}
            </div>
          )}

          <Textarea
            label={t.rate.reason}
            hint={t.common.optional}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t.rate.reasonPlaceholder}
          />

          {Number.isFinite(parsed) && parsed !== currentRate && (
            <p className="rounded-xl bg-canvas px-3.5 py-2.5 text-sm text-ink">
              From <strong>{formatMonth(effectiveFrom)}</strong>, bills will be{" "}
              <strong className="tnum">{formatCurrency(parsed)}</strong> instead of{" "}
              <span className="tnum">{formatCurrency(currentRate)}</span>.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

/** Reassigns a client to another area (spec sections 19, 25). */
export function ChangeAreaButton({
  clientId,
  currentAreaId,
  areas,
}: {
  clientId: string;
  currentAreaId: string | null;
  areas: Pick<Area, "id" | "name">[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [areaId, setAreaId] = useState(currentAreaId ?? "");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(undefined);
    startTransition(async () => {
      const result = await setClientAreaAction(clientId, areaId || null);
      if (result.ok) {
        toast.success(t.area.assigned);
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <MapPin className="size-4" />
        {t.area.assign}
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.area.assign}
        description={t.area.hint}
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
              {pending ? t.common.saving : t.common.save}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <FormError>{error}</FormError>
          <Select
            label={t.area.one}
            value={areaId}
            onChange={(event) => setAreaId(event.target.value)}
            options={[
              { value: "", label: t.area.none },
              ...areas.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <p className="text-xs text-ink-faint">
            Past bills and payments are never changed - only where this client is counted from now
            on.
          </p>
        </div>
      </Modal>
    </>
  );
}

/** Month options helper re-exported so pages can build selectors consistently. */
export { monthOptions };

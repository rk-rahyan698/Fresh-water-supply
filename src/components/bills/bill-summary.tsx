import { BillStatusBadge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { AdjustmentType, MonthlyBill } from "@/types/database";

const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  discount: t.adjustment.discount,
  waiver: t.adjustment.waiver,
  special_reduction: t.adjustment.specialReduction,
  other: t.adjustment.other,
};

export function adjustmentTypeLabel(type: AdjustmentType | null): string {
  return type ? ADJUSTMENT_LABELS[type] : t.adjustment.none;
}

/** The subset of a bill this summary needs - works with partial selects too. */
export type BillFigures = Pick<
  MonthlyBill,
  | "bill_amount"
  | "adjustment_amount"
  | "adjusted_amount"
  | "paid_amount"
  | "due_amount"
  | "status"
> &
  Partial<Pick<MonthlyBill, "adjustment_type" | "adjustment_reason" | "adjusted_at">>;

/**
 * The financial breakdown of one bill (spec section 17).
 *
 * Original -> Adjustment -> Adjusted -> Paid -> Due is shown as a ladder so
 * the two situations that look alike stay visibly different:
 *
 *   paid 800 of 1000, no adjustment  -> Due 200   (client still owes)
 *   paid 800 of 1000, adjustment 200 -> Due 0     (business waived it)
 *
 * The adjustment rows stay muted at zero rather than disappearing, so nobody
 * has to wonder whether a discount was applied and simply not shown.
 */
export function BillFinancialSummary({
  bill,
  approvedBy,
  className,
}: {
  bill: BillFigures;
  approvedBy?: string | null;
  className?: string;
}) {
  const adjustment = Number(bill.adjustment_amount ?? 0);
  const hasAdjustment = adjustment > 0;
  const due = Number(bill.due_amount);

  return (
    <div className={cn("overflow-hidden rounded-xl border border-line", className)}>
      <dl className="divide-y divide-line text-sm">
        <Row label={t.bill.originalBill} value={formatCurrency(bill.bill_amount)} />
        <Row
          label={t.bill.adjustment}
          value={hasAdjustment ? `- ${formatCurrency(adjustment)}` : formatCurrency(0)}
          tone={hasAdjustment ? "adjust" : "muted"}
          badge={
            hasAdjustment && bill.adjustment_type ? (
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                {adjustmentTypeLabel(bill.adjustment_type)}
              </span>
            ) : undefined
          }
        />
        <Row
          label={t.bill.adjustedBill}
          value={formatCurrency(bill.adjusted_amount)}
          strong
          tone={hasAdjustment ? "adjust" : undefined}
        />
        <Row label={t.bill.paid} value={formatCurrency(bill.paid_amount)} tone="positive" />
        <Row
          label={t.bill.remainingDue}
          value={formatCurrency(due)}
          strong
          tone={due > 0 ? "danger" : "positive"}
        />
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
          <dt className="text-ink-soft">{t.bill.status}</dt>
          <dd>
            <BillStatusBadge status={bill.status} />
          </dd>
        </div>
      </dl>

      {hasAdjustment && bill.adjustment_reason && (
        <div className="border-t border-line bg-brand-50/50 px-3.5 py-2.5">
          <p className="text-xs font-medium text-brand-700">
            {t.adjustment.reason}: <span className="font-normal text-ink">{bill.adjustment_reason}</span>
          </p>
          {(approvedBy || bill.adjusted_at) && (
            <p className="mt-0.5 text-xs text-ink-faint">
              {approvedBy ? `${t.adjustment.approvedBy}: ${approvedBy}` : ""}
              {approvedBy && bill.adjusted_at ? " · " : ""}
              {bill.adjusted_at ? formatDate(bill.adjusted_at.slice(0, 10)) : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
  badge,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "danger" | "positive" | "muted" | "adjust";
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className={cn("flex items-center gap-2", tone === "muted" ? "text-ink-faint" : "text-ink-soft")}>
        {label}
        {badge}
      </dt>
      <dd
        className={cn(
          "tnum text-right",
          strong ? "text-base font-semibold" : "font-medium",
          tone === "danger" && "text-danger",
          tone === "positive" && "text-positive",
          tone === "muted" && "text-ink-faint",
          tone === "adjust" && "text-brand-700",
          !tone && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Inline "1,000 − 200 = 800" note for table rows, where a full ladder does not
 * fit. Renders nothing when there is no adjustment.
 */
export function AdjustmentNote({ bill }: { bill: BillFigures }) {
  const adjustment = Number(bill.adjustment_amount ?? 0);
  if (adjustment <= 0) return null;

  return (
    <span className="block text-xs text-brand-700">
      {formatCurrency(bill.bill_amount)} − {formatCurrency(adjustment)}{" "}
      {bill.adjustment_type ? `(${adjustmentTypeLabel(bill.adjustment_type)})` : ""}
    </span>
  );
}

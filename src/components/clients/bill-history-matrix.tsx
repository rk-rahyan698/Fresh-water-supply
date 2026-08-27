"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, CircleSlash, Clock, Percent, Loader2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { BillStatusBadge, PaymentMethodBadge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import {
  getBillDetailAction,
  type BillDetail,
} from "@/lib/actions/bill-detail";
import { formatCurrency, formatDate, formatMonth, formatReceiptNo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { BillMatrixCell } from "@/lib/queries/clients";
import type { BillStatus } from "@/types/database";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Status is never carried by colour alone (spec section 9): every cell shows
 * an icon and a word as well.
 */
const STATUS_META: Record<BillStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  paid: { label: "Paid", icon: CheckCircle2, className: "text-positive" },
  partial: { label: "Partial", icon: Clock, className: "text-warning" },
  unpaid: { label: "Unpaid", icon: CircleSlash, className: "text-danger" },
};

/**
 * Year x Month bill history (spec sections 6-11).
 *
 * Months are rows and years are columns, so a client with a decade of history
 * reads as a compact grid instead of a hundred-row scroll. The server hands us
 * one bounded year range at a time; the year selector re-queries rather than
 * loading everything.
 */
export function BillHistoryMatrix({
  clientName,
  cells,
  years,
  selectedYears,
  onYearChange,
}: {
  clientName: string;
  cells: BillMatrixCell[];
  /** Every year this client has bills for - drives the selector. */
  years: number[];
  /** The year columns currently rendered, ascending. */
  selectedYears: number[];
  onYearChange?: React.ReactNode;
}) {
  const [detail, setDetail] = useState<BillDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  // month -> year -> cell
  const byMonthYear = new Map<number, Map<number, BillMatrixCell>>();
  for (const cell of cells) {
    if (!byMonthYear.has(cell.month)) byMonthYear.set(cell.month, new Map());
    byMonthYear.get(cell.month)!.set(cell.year, cell);
  }

  const open = (cell: BillMatrixCell) => {
    setLoadingId(cell.billId);
    startTransition(async () => {
      const result = await getBillDetailAction(cell.billId);
      setLoadingId(null);
      if (result.ok) setDetail(result.data);
      else toast.error(result.error);
    });
  };

  const monthsWithData = MONTHS.map((_, i) => i + 1).filter((m) => byMonthYear.has(m));

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t.bill.history}
        description={
          years.length > 1
            ? `${t.bill.historyDescription} ${years.length} years on record.`
            : t.bill.historyDescription
        }
        action={onYearChange}
      />

      {cells.length === 0 ? (
        <EmptyState
          title={t.bill.noBillsYear}
          description="Pick another year, or generate bills for this client."
        />
      ) : (
        // Horizontal scroll on phones rather than a squashed table (section 34).
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead className="bg-canvas/70">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-10 border-b border-line bg-canvas/95 px-3 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-soft uppercase backdrop-blur"
                >
                  {t.common.month}
                </th>
                {selectedYears.map((year) => (
                  <th
                    key={year}
                    scope="col"
                    className="border-b border-line px-3 py-2.5 text-right text-xs font-semibold tracking-wide text-ink-soft uppercase"
                  >
                    {year}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {monthsWithData.map((month) => (
                <tr key={month} className="transition-colors hover:bg-canvas/50">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-surface/95 px-3 py-2 text-left font-medium whitespace-nowrap text-ink backdrop-blur"
                  >
                    {MONTHS[month - 1]}
                  </th>
                  {selectedYears.map((year) => {
                    const cell = byMonthYear.get(month)?.get(year);
                    return (
                      <td key={year} className="px-1.5 py-1.5 align-top">
                        {cell ? (
                          <MatrixCell
                            cell={cell}
                            loading={loadingId === cell.billId && pending}
                            onOpen={() => open(cell)}
                          />
                        ) : (
                          <span className="block py-2 text-center text-xs text-ink-faint">-</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-line px-4 py-2.5 text-xs text-ink-faint sm:px-5">
        Tap any month to see its bill and payments.
      </div>

      {detail && (
        <BillDetailModal
          detail={detail}
          clientName={clientName}
          onClose={() => setDetail(null)}
        />
      )}
    </Card>
  );
}

function MatrixCell({
  cell,
  loading,
  onOpen,
}: {
  cell: BillMatrixCell;
  loading: boolean;
  onOpen: () => void;
}) {
  const meta = STATUS_META[cell.status];
  const Icon = meta.icon;
  const hasAdjustment = cell.adjustmentAmount > 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${formatMonth(cell.billingMonth)}: ${formatCurrency(cell.adjustedAmount)}, ${meta.label}`}
      className={cn(
        "flex w-full flex-col items-end gap-0.5 rounded-lg border border-line px-2 py-1.5",
        "text-right transition-colors hover:border-brand-300 hover:bg-brand-50/60",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500",
      )}
    >
      <span className="tnum text-sm font-semibold text-ink">
        {formatCurrency(cell.adjustedAmount)}
      </span>

      {hasAdjustment && (
        <span className="flex items-center gap-0.5 text-[11px] text-brand-700">
          <Percent className="size-2.5" />
          {formatCurrency(cell.adjustmentAmount)} off
        </span>
      )}

      <span className={cn("flex items-center gap-1 text-[11px] font-medium", meta.className)}>
        {loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Icon className="size-3" aria-hidden />
        )}
        {cell.status === "partial" ? `Due ${formatCurrency(cell.dueAmount)}` : meta.label}
      </span>
    </button>
  );
}

/** Full bill detail, opened from a cell (spec section 10). */
function BillDetailModal({
  detail,
  clientName,
  onClose,
}: {
  detail: BillDetail;
  clientName: string;
  onClose: () => void;
}) {
  const hasAdjustment = detail.adjustmentAmount > 0;
  const valid = detail.payments.filter((p) => !p.voided);

  return (
    <Modal
      open
      onClose={onClose}
      title={formatMonth(detail.billingMonth)}
      description={clientName}
      footer={
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl border border-line bg-white px-4 text-sm font-medium text-ink hover:bg-canvas"
          >
            {t.common.close}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="overflow-hidden rounded-xl border border-line">
          <dl className="divide-y divide-line text-sm">
            <DetailRow label={t.bill.originalBill} value={formatCurrency(detail.billAmount)} />
            <DetailRow
              label={t.bill.adjustment}
              value={hasAdjustment ? `- ${formatCurrency(detail.adjustmentAmount)}` : formatCurrency(0)}
              tone={hasAdjustment ? "brand" : "muted"}
            />
            <DetailRow
              label={t.bill.adjustedBill}
              value={formatCurrency(detail.adjustedAmount)}
              strong
            />
            <DetailRow label={t.bill.paid} value={formatCurrency(detail.paidAmount)} tone="positive" />
            <DetailRow
              label={t.bill.remainingDue}
              value={formatCurrency(detail.dueAmount)}
              strong
              tone={detail.dueAmount > 0 ? "danger" : "positive"}
            />
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <dt className="text-ink-soft">{t.bill.status}</dt>
              <dd>
                <BillStatusBadge status={detail.status} />
              </dd>
            </div>
          </dl>
          {hasAdjustment && detail.adjustmentReason && (
            <div className="border-t border-line bg-brand-50/50 px-3.5 py-2.5 text-xs">
              <p className="font-medium text-brand-700">
                {t.adjustment.reason}:{" "}
                <span className="font-normal text-ink">{detail.adjustmentReason}</span>
              </p>
              {detail.approvedBy && (
                <p className="mt-0.5 text-ink-faint">
                  {t.adjustment.approvedBy}: {detail.approvedBy}
                </p>
              )}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">
            {t.bill.paymentsOnBill}
            <span className="ml-1.5 font-normal text-ink-faint">({valid.length})</span>
          </h3>
          {detail.payments.length === 0 ? (
            <p className="rounded-xl bg-canvas px-3.5 py-3 text-sm text-ink-soft">
              {t.payment.empty}
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {detail.payments.map((payment) => (
                <li
                  key={payment.id}
                  className={cn("px-3.5 py-2.5", payment.voided && "bg-danger-soft/25")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                        {formatDate(payment.paymentDate)}
                        <PaymentMethodBadge method={payment.paymentMethod} />
                        {payment.voided && (
                          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
                            {t.payment.voided}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-soft">
                        {formatReceiptNo(payment.receiptNo)}
                        {payment.collectorName ? ` · ${payment.collectorName}` : ""}
                      </p>
                      {payment.voided && payment.voidReason && (
                        <p className="mt-0.5 text-xs text-danger">{payment.voidReason}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span
                        className={cn(
                          "tnum text-sm font-semibold",
                          payment.voided ? "text-ink-faint line-through" : "text-ink",
                        )}
                      >
                        {formatCurrency(payment.amount)}
                      </span>
                      <Link
                        href={`/receipt/${payment.id}`}
                        className="text-xs font-medium text-brand-700 hover:underline"
                      >
                        {t.payment.receipt}
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function DetailRow({
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
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className={tone === "muted" ? "text-ink-faint" : "text-ink-soft"}>{label}</dt>
      <dd
        className={cn(
          "tnum",
          strong ? "text-base font-semibold" : "font-medium",
          tone === "danger" && "text-danger",
          tone === "positive" && "text-positive",
          tone === "brand" && "text-brand-700",
          tone === "muted" && "text-ink-faint",
          !tone && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

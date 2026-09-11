"use client";

import { useState } from "react";
import Link from "next/link";
import { FileDown, Receipt } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PaymentMethodBadge } from "@/components/ui/badge";
import {
  MobileCard,
  MobileField,
  Table,
  TableWrap,
  TBody,
  TD,
  TFootRow,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { downloadCsv, safeFilename } from "@/lib/export/csv";
import {
  addPdfSummary,
  addPdfTable,
  createPdfDoc,
  pdfMoney,
  pdfNumber,
  savePdf,
  type PdfDoc,
} from "@/lib/export/pdf";
import { formatRanges, summariseBillMonths } from "@/lib/collection-math";
import { formatCurrency, formatDate, formatMonth, formatReceiptNo } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { ClientPaymentRow } from "@/lib/queries/collection-report";
import type { BillMatrixCell } from "@/lib/queries/clients";
import type { ClientFinancialSummary } from "@/types/database";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  bank: "Bank",
  mobile_banking: "Mobile Banking",
  other: "Other",
};

export interface ClientExportInfo {
  name: string;
  code: string;
  phone: string | null;
  address: string | null;
  areaName: string | null;
  monthlyBill: number;
  businessName: string;
}

/**
 * A client's payment record, with PDF and CSV export.
 *
 * Kept separate from the Profile screen on purpose (spec section 21): Profile
 * answers "who is this and what do they owe", this answers "what have they
 * paid and when".
 */
export function ClientPaymentsView({
  client,
  payments,
  summary,
  billCells,
  collectAction,
}: {
  client: ClientExportInfo;
  payments: ClientPaymentRow[];
  summary: ClientFinancialSummary;
  /** Bills for the year window, used by the bill-history PDF. */
  billCells: BillMatrixCell[];
  collectAction?: React.ReactNode;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const valid = payments.filter((p) => !p.voided);
  const totalPaid = valid.reduce((sum, p) => sum + p.amount, 0);

  // The monthly bill as it was actually billed, month by month, across the
  // years loaded - so a statement for a client whose bill was raised part-way
  // through does not print today's rate as if it had always applied. Original
  // bill_amount, not the adjusted figure: a discount is not a rate change.
  const billYears = [...new Set(billCells.map((c) => c.year))].sort((a, b) => a - b);
  const billLabels = billYears.flatMap((year) => MONTHS.map((m) => `${m.slice(0, 3)} ${year}`));
  const cellAt = new Map(billCells.map((c) => [`${c.year}-${c.month}`, c]));
  const billHistory = summariseBillMonths(
    billYears.flatMap((year) =>
      MONTHS.map((_, i) => cellAt.get(`${year}-${i + 1}`)?.billAmount ?? null),
    ),
  );

  const clientMeta = [
    { label: "Client", value: client.name },
    { label: "Code", value: client.code },
    { label: "Phone", value: client.phone ?? "-" },
    { label: "Area", value: client.areaName ?? "Unassigned" },
    { label: "Address", value: client.address ?? "-" },
    {
      label: "Monthly bill",
      // Header values are single lines; the full history gets its own table.
      value: billHistory.changed
        ? `${pdfMoney(client.monthlyBill)} (changed - see history)`
        : pdfMoney(client.monthlyBill),
    },
  ];

  /** Amount and months, one row per change. Drawn only when it changed. */
  const addMonthlyBillHistory = (pdf: PdfDoc) => {
    if (!billHistory.changed) return;
    pdf.cursorY = addPdfTable(pdf, {
      head: [[`Monthly bill history (${billYears[0]}-${billYears[billYears.length - 1]})`, "Billed for"]],
      body: billHistory.segments.map((segment) => [
        pdfMoney(segment.amount),
        formatRanges(segment.ranges, billLabels, " to "),
      ]),
      tableWidth: 360,
      styles: { fontSize: 8, cellPadding: 3.5 },
      columnStyles: { 0: { cellWidth: 150, halign: "right" } },
    });
  };

  /* ----------------------------------------------------- payment history PDF */
  const exportPaymentsPdf = () => {
    if (payments.length === 0) {
      toast.error(t.export.noRows);
      return;
    }
    setBusy("payments-pdf");
    try {
      const pdf = createPdfDoc({
        businessName: client.businessName,
        title: "Payment History",
        subtitle: `${client.name} (${client.code})`,
        meta: clientMeta,
      });

      pdf.cursorY = addPdfSummary(
        pdf,
        [
          { label: "Total billed (original)", value: pdfMoney(summary.original_amount) },
          { label: "Total adjustments / discounts", value: pdfMoney(summary.adjustment_amount) },
          { label: "Total payable after adjustments", value: pdfMoney(summary.adjusted_amount) },
          { label: "Total paid", value: pdfMoney(summary.collected_amount), strong: true },
          { label: "Total outstanding", value: pdfMoney(summary.outstanding), strong: true },
        ],
        pdf.cursorY,
      );

      addMonthlyBillHistory(pdf);

      addPdfTable(pdf, {
        head: [["Billing Month", "Payment Date", "Amount", "Method", "Collected By", "Reference"]],
        body: payments.map((p) => [
          formatMonth(p.billingMonth),
          formatDate(p.paymentDate),
          p.voided ? `${pdfNumber(p.amount)} (VOID)` : pdfNumber(p.amount),
          METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod,
          p.collectorName ?? "-",
          formatReceiptNo(p.receiptNo),
        ]),
        foot: [["", "Total (excluding voided)", pdfNumber(totalPaid), "", "", ""]],
        columnStyles: {
          2: { halign: "right" },
        },
      });

      savePdf(pdf, safeFilename(["payment-history", client.code, client.name]));
      toast.success(t.export.done);
    } catch {
      toast.error(t.export.failed);
    } finally {
      setBusy(null);
    }
  };

  /* -------------------------------------------------------- bill history PDF */
  const exportBillsPdf = () => {
    if (billCells.length === 0) {
      toast.error(t.export.noRows);
      return;
    }
    setBusy("bills-pdf");
    try {
      const years = [...new Set(billCells.map((c) => c.year))].sort();
      // month -> year -> cell
      const grid = new Map<number, Map<number, BillMatrixCell>>();
      for (const cell of billCells) {
        if (!grid.has(cell.month)) grid.set(cell.month, new Map());
        grid.get(cell.month)!.set(cell.year, cell);
      }

      const pdf = createPdfDoc({
        businessName: client.businessName,
        title: "Bill History",
        subtitle: `${client.name} (${client.code}) · ${years.join(" - ")}`,
        // Years as columns stays readable up to about five; past that the
        // page is better served landscape.
        orientation: years.length > 4 ? "landscape" : "portrait",
        meta: clientMeta,
      });

      addMonthlyBillHistory(pdf);

      addPdfTable(pdf, {
        head: [["Month", ...years.map(String)]],
        body: MONTHS.map((name, i) => {
          const month = i + 1;
          return [
            name,
            ...years.map((year) => {
              const cell = grid.get(month)?.get(year);
              if (!cell) return "-";
              // Amount, then the state underneath, so the cell is readable
              // without relying on colour in print.
              const lines = [pdfNumber(cell.adjustedAmount)];
              if (cell.adjustmentAmount > 0) {
                lines.push(`less ${pdfNumber(cell.adjustmentAmount)}`);
              }
              lines.push(
                cell.status === "partial"
                  ? `Due ${pdfNumber(cell.dueAmount)}`
                  : cell.status === "paid"
                    ? "Paid"
                    : "Unpaid",
              );
              return lines.join("\n");
            }),
          ];
        }),
        styles: { fontSize: 8, cellPadding: 3.5 },
        columnStyles: { 0: { cellWidth: 70, fontStyle: "bold" } },
        didParseCell: (data) => {
          if (data.column.index > 0) data.cell.styles.halign = "right";
        },
      });

      savePdf(pdf, safeFilename(["bill-history", client.code, client.name]));
      toast.success(t.export.done);
    } catch {
      toast.error(t.export.failed);
    } finally {
      setBusy(null);
    }
  };

  /* ---------------------------------------------------------------- CSV */
  const exportCsv = () => {
    if (payments.length === 0) {
      toast.error(t.export.noRows);
      return;
    }
    setBusy("csv");
    try {
      const header = [
        "Client Code", "Client Name", "Area", "Billing Month", "Payment Date",
        "Amount", "Payment Method", "Collected By", "Reference", "Voided", "Notes",
      ];
      const body = payments.map((p) => [
        client.code,
        client.name,
        client.areaName ?? "Unassigned",
        formatMonth(p.billingMonth),
        p.paymentDate,
        p.amount.toFixed(2),
        METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod,
        p.collectorName ?? "",
        formatReceiptNo(p.receiptNo),
        p.voided ? "YES" : "NO",
        p.notes ?? "",
      ]);
      downloadCsv(safeFilename(["payments", client.code, client.name]), [header, ...body]);
      toast.success(t.export.done);
    } catch {
      toast.error(t.export.failed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t.clientPayments.history}
        description={`${valid.length} payments · ${formatCurrency(totalPaid)} collected`}
        action={
          <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            {collectAction}
            <Button
              variant="secondary"
              size="sm"
              onClick={exportPaymentsPdf}
              loading={busy === "payments-pdf"}
              disabled={busy !== null}
            >
              <FileDown className="size-4" />
              <span className="hidden sm:inline">Payment PDF</span>
              <span className="sm:hidden">PDF</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportBillsPdf}
              loading={busy === "bills-pdf"}
              disabled={busy !== null}
            >
              <FileDown className="size-4" />
              <span className="hidden sm:inline">Bill PDF</span>
              <span className="sm:hidden">Bills</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={exportCsv}
              loading={busy === "csv"}
              disabled={busy !== null}
            >
              CSV
            </Button>
          </div>
        }
      />

      {payments.length === 0 ? (
        <EmptyState icon={Receipt} title={t.clientPayments.noHistory} />
      ) : (
        <>
          {/* Mobile */}
          <div className="sm:hidden">
            {payments.map((p) => (
              <MobileCard key={p.paymentId} className={p.voided ? "bg-danger-soft/25" : undefined}>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{formatMonth(p.billingMonth)}</p>
                    <p className="text-xs text-ink-faint">{formatReceiptNo(p.receiptNo)}</p>
                  </div>
                  <span
                    className={`tnum text-base font-semibold ${
                      p.voided ? "text-ink-faint line-through" : "text-ink"
                    }`}
                  >
                    {formatCurrency(p.amount)}
                  </span>
                </div>
                <MobileField label={t.common.date} value={formatDate(p.paymentDate)} />
                <MobileField label={t.payment.collectedBy} value={p.collectorName ?? "-"} />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <PaymentMethodBadge method={p.paymentMethod} />
                  <Link
                    href={`/receipt/${p.paymentId}`}
                    className="text-xs font-medium text-brand-700 hover:underline"
                  >
                    {t.payment.receipt}
                  </Link>
                </div>
                {p.notes && <p className="mt-1.5 text-xs text-ink-faint italic">{p.notes}</p>}
                {p.voided && (
                  <p className="mt-1 text-xs text-danger">
                    {t.payment.voided}
                    {p.voidReason ? ` · ${p.voidReason}` : ""}
                  </p>
                )}
              </MobileCard>
            ))}
          </div>

          {/* Desktop */}
          <TableWrap className="hidden sm:block">
            <Table>
              <THead>
                <TR>
                  <TH>{t.bill.billingMonth}</TH>
                  <TH>{t.common.date}</TH>
                  <TH align="right">{t.payment.amount}</TH>
                  <TH>{t.payment.method}</TH>
                  <TH>{t.payment.collectedBy}</TH>
                  <TH>{t.payment.receiptNo}</TH>
                  <TH>{t.common.notes}</TH>
                </TR>
              </THead>
              <TBody>
                {payments.map((p) => (
                  <TR key={p.paymentId} className={p.voided ? "bg-danger-soft/25" : undefined}>
                    <TD className="font-medium whitespace-nowrap">
                      {formatMonth(p.billingMonth)}
                    </TD>
                    <TD className="whitespace-nowrap">{formatDate(p.paymentDate)}</TD>
                    <TD
                      align="right"
                      numeric
                      className={
                        p.voided ? "font-semibold text-ink-faint line-through" : "font-semibold"
                      }
                    >
                      {formatCurrency(p.amount)}
                    </TD>
                    <TD>
                      <PaymentMethodBadge method={p.paymentMethod} />
                    </TD>
                    <TD className="text-ink-soft">{p.collectorName ?? "-"}</TD>
                    <TD>
                      <Link
                        href={`/receipt/${p.paymentId}`}
                        className="font-mono text-xs text-brand-700 hover:underline"
                      >
                        {formatReceiptNo(p.receiptNo)}
                      </Link>
                    </TD>
                    <TD className="max-w-xs truncate text-xs text-ink-faint">
                      {p.voided ? `Voided: ${p.voidReason ?? ""}` : (p.notes ?? "-")}
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFootRow>
                <TD>{t.report.grandTotal}</TD>
                <TD />
                <TD align="right" numeric>
                  {formatCurrency(totalPaid)}
                </TD>
                <TD />
                <TD />
                <TD />
                <TD />
              </TFootRow>
            </Table>
          </TableWrap>
        </>
      )}
    </Card>
  );
}

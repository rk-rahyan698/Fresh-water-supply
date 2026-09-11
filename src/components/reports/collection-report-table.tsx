"use client";

import { useState } from "react";
import Link from "next/link";
import { FileDown, FileSpreadsheet } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { downloadCsv, safeFilename } from "@/lib/export/csv";
import {
  addPdfSummary,
  addPdfTable,
  createPdfDoc,
  pdfMoney,
  pdfNumber,
  savePdf,
} from "@/lib/export/pdf";
import {
  formatRanges,
  isFlatFullYear,
  summariseBillMonths,
  type BillMonthsSummary,
} from "@/lib/collection-math";
import { formatCurrency } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { CollectionMatrixRow } from "@/lib/queries/collection-report";
import type { CollectionSummary } from "@/types/database";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface ReportContext {
  year: number;
  areaLabel: string;
  collectorLabel: string;
  businessName: string;
}

/**
 * The monthly bill as plain text lines, for the exports.
 *
 *   one amount all year   -> []                     (the amount alone says it)
 *   raised in July        -> ["1,000 Jan-Jun", "1,200 Jul-Dec"]
 *   started in May        -> ["800 May-Dec"]
 *
 * Built from what each month was actually billed, so a rate change mid-year,
 * an edited month, or a client who joined part-way through all read correctly.
 */
function billDetailLines(summary: BillMonthsSummary): string[] {
  if (summary.segments.length === 0 || isFlatFullYear(summary)) return [];
  return summary.segments.map(
    (segment) => `${pdfNumber(segment.amount)} ${formatRanges(segment.ranges, MONTHS_SHORT, "-")}`,
  );
}

/**
 * Client x Month collection matrix with CSV and PDF export.
 *
 * The exports are built from exactly the rows on screen, so a filtered view
 * and its download can never disagree (spec section 16).
 */
export function CollectionReportTable({
  rows,
  summary,
  context,
}: {
  rows: CollectionMatrixRow[];
  summary: CollectionSummary;
  context: ReportContext;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"csv" | "pdf" | null>(null);

  // Column totals, computed once and reused by the screen and both exports.
  const monthTotals = MONTHS_SHORT.map((_, i) =>
    rows.reduce((sum, row) => sum + row.months[i], 0),
  );
  const grandTotal = rows.reduce((sum, row) => sum + row.yearTotal, 0);
  // Summarised once per row; the screen, the CSV and the PDF all read this.
  const billSummaries = new Map(
    rows.map((row) => [row.clientId, summariseBillMonths(row.billMonths ?? [])]),
  );

  const filenameParts = [
    "collection-report",
    context.year,
    context.areaLabel !== "All areas" ? context.areaLabel : null,
    context.collectorLabel !== "All collectors" ? context.collectorLabel : null,
  ];

  const exportCsv = () => {
    if (rows.length === 0) {
      toast.error(t.export.noRows);
      return;
    }
    setBusy("csv");
    try {
      // Accounting-friendly columns; 0 rather than blank (spec section 18).
      // "Monthly Bill" stays a plain number so a spreadsheet can use it; the
      // detail column spells out the months when the amount changed.
      const header = [
        "Client Code",
        "Client Name",
        "Area",
        "Monthly Bill",
        "Monthly Bill Detail",
        ...MONTHS_LONG,
        "Year Total",
      ];
      const body = rows.map((row) => {
        const bills = billSummaries.get(row.clientId)!;
        return [
          row.clientCode,
          row.clientName,
          row.areaName ?? "Unassigned",
          bills.latest === null ? "" : bills.latest.toFixed(2),
          billDetailLines(bills).join("; "),
          ...row.months.map((v) => v.toFixed(2)),
          row.yearTotal.toFixed(2),
        ];
      });
      const total = [
        "",
        "TOTAL",
        "",
        "",
        "",
        ...monthTotals.map((v) => v.toFixed(2)),
        grandTotal.toFixed(2),
      ];

      downloadCsv(safeFilename(filenameParts), [header, ...body, total]);
      toast.success(t.export.done);
    } catch {
      toast.error(t.export.failed);
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = () => {
    if (rows.length === 0) {
      toast.error(t.export.noRows);
      return;
    }
    setBusy("pdf");
    try {
      // Landscape: twelve month columns plus a total never fit portrait.
      const pdf = createPdfDoc({
        businessName: context.businessName,
        title: t.collections.title,
        subtitle: `Collections during ${context.year}, by the month the money was received. Monthly bill is by billing month.`,
        orientation: "landscape",
        meta: [
          { label: "Year", value: String(context.year) },
          { label: "Area", value: context.areaLabel },
          { label: "Collector", value: context.collectorLabel },
          { label: "Clients", value: String(rows.length) },
        ],
      });

      const afterSummary = addPdfSummary(
        pdf,
        [
          { label: "Total collected", value: pdfMoney(summary.total_collected), strong: true },
          { label: "Payments recorded", value: String(summary.payment_count) },
          { label: "Original bills", value: pdfMoney(summary.original_amount) },
          { label: "Adjustments / discounts", value: pdfMoney(summary.adjustment_amount) },
          { label: "Adjusted bills", value: pdfMoney(summary.adjusted_amount) },
          { label: "Outstanding due", value: pdfMoney(summary.outstanding), strong: true },
        ],
        pdf.cursorY,
      );
      pdf.cursorY = afterSummary;

      addPdfTable(pdf, {
        head: [["Client", "Area", "Monthly bill", ...MONTHS_SHORT, "Total"]],
        body: rows.map((row) => {
          const bills = billSummaries.get(row.clientId)!;
          const detail = billDetailLines(bills);
          return [
            `${row.clientName}\n${row.clientCode}`,
            row.areaName ?? "Unassigned",
            // One amount all year prints as the amount. A change prints each
            // amount on its own line with the months it applied to, so the
            // row grows rather than the figure being wrong for half the year.
            bills.latest === null ? "-" : detail.length > 0 ? detail.join("\n") : pdfNumber(bills.latest),
            ...row.months.map((v) => (v === 0 ? "0" : pdfNumber(v))),
            pdfNumber(row.yearTotal),
          ];
        }),
        foot: [
          [
            "TOTAL",
            "",
            "",
            ...monthTotals.map((v) => pdfNumber(v)),
            pdfNumber(grandTotal),
          ],
        ],
        styles: { fontSize: 7, cellPadding: 3 },
        headStyles: { fontSize: 7 },
        columnStyles: {
          0: { cellWidth: 86, halign: "left" },
          1: { cellWidth: 50, halign: "left" },
          2: { cellWidth: 68 },
          15: { fontStyle: "bold" },
        },
        // Monthly bill and every month column right-aligned; numbers line up.
        didParseCell: (data) => {
          if (data.column.index >= 2) data.cell.styles.halign = "right";
        },
      });

      savePdf(pdf, safeFilename(filenameParts));
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
        title={`${context.year} ${t.collections.title.toLowerCase()}`}
        description={`${rows.length} clients · ${t.export.respectsFilters}`}
        action={
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              onClick={exportCsv}
              loading={busy === "csv"}
              disabled={busy !== null}
            >
              <FileSpreadsheet className="size-4" />
              <span className="hidden sm:inline">{t.export.excel}</span>
              <span className="sm:hidden">CSV</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportPdf}
              loading={busy === "pdf"}
              disabled={busy !== null}
            >
              <FileDown className="size-4" />
              <span className="hidden sm:inline">{t.export.pdf}</span>
              <span className="sm:hidden">PDF</span>
            </Button>
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState title={t.collections.empty} description={t.collections.basisNote} />
      ) : (
        // Wide by nature: scrolls inside its own container, and the client
        // column stays pinned so a row stays identifiable while scrolling.
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <thead className="bg-canvas/70">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-10 border-b border-line bg-canvas/95 px-3 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-soft uppercase backdrop-blur"
                >
                  {t.client.one}
                </th>
                <th
                  scope="col"
                  className="border-b border-line px-3 py-2.5 text-right text-xs font-semibold tracking-wide whitespace-nowrap text-ink-soft uppercase"
                >
                  {t.collections.monthlyBill}
                </th>
                {MONTHS_SHORT.map((month) => (
                  <th
                    key={month}
                    scope="col"
                    className="border-b border-line px-2 py-2.5 text-right text-xs font-semibold tracking-wide text-ink-soft uppercase"
                  >
                    {month}
                  </th>
                ))}
                <th
                  scope="col"
                  className="border-b border-line px-3 py-2.5 text-right text-xs font-semibold tracking-wide text-ink-soft uppercase"
                >
                  {t.collections.yearTotal}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.clientId} className="transition-colors hover:bg-canvas/50">
                  <th scope="row" className="sticky left-0 z-10 bg-surface/95 px-3 py-2 text-left backdrop-blur">
                    <Link
                      href={`/clients/${row.clientId}/payments`}
                      className="block text-sm font-medium whitespace-nowrap text-brand-700 hover:underline"
                    >
                      {row.clientName}
                    </Link>
                    <span className="block text-xs font-normal whitespace-nowrap text-ink-faint">
                      {row.clientCode}
                      {row.areaName ? ` · ${row.areaName}` : ""}
                    </span>
                  </th>
                  <td className="border-r border-line/60 px-3 py-2 text-right align-top">
                    <MonthlyBillCell summary={billSummaries.get(row.clientId)!} />
                  </td>
                  {row.months.map((value, i) => (
                    <td
                      key={i}
                      className={`tnum px-2 py-2 text-right ${
                        value > 0 ? "text-ink" : "text-ink-faint"
                      }`}
                    >
                      {value > 0 ? value.toLocaleString("en-US") : "0"}
                    </td>
                  ))}
                  <td className="tnum px-3 py-2 text-right font-semibold text-ink">
                    {row.yearTotal.toLocaleString("en-US")}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line bg-canvas font-semibold text-ink">
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-canvas px-3 py-2.5 text-left whitespace-nowrap"
                >
                  {t.collections.grandTotal}
                </th>
                {/* No total: summing monthly rates across clients means nothing. */}
                <td className="border-r border-line/60" />
                {monthTotals.map((value, i) => (
                  <td key={i} className="tnum px-2 py-2.5 text-right">
                    {value.toLocaleString("en-US")}
                  </td>
                ))}
                <td className="tnum px-3 py-2.5 text-right">
                  {formatCurrency(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="border-t border-line px-4 py-2.5 text-xs text-ink-faint sm:px-5">
        {t.collections.basisNote} {t.collections.monthlyBillNote}
      </p>
    </Card>
  );
}

/**
 * One amount all year: just the amount. Otherwise each amount with the months
 * it applied to, newest last, and a marker so a change is seen at a glance.
 */
function MonthlyBillCell({ summary }: { summary: BillMonthsSummary }) {
  if (summary.latest === null) {
    return <span className="text-ink-faint">-</span>;
  }

  if (isFlatFullYear(summary)) {
    return <span className="tnum font-medium whitespace-nowrap text-ink">{formatCurrency(summary.latest)}</span>;
  }

  // One amount over part of the year (a client who started in August, or the
  // current year before December): amount over months, two lines. Rows are
  // already two lines tall, so this narrows the column without growing rows -
  // on one line it pushed the year total off a laptop-width screen.
  if (!summary.changed && summary.segments.length === 1) {
    return (
      <div className="leading-tight whitespace-nowrap">
        <span className="tnum block font-medium text-ink">{formatCurrency(summary.latest)}</span>
        <span className="block text-xs text-ink-faint">
          {formatRanges(summary.segments[0].ranges, MONTHS_SHORT)}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 text-right">
      {summary.changed && (
        <span className="inline-block rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-brand-700 uppercase">
          {t.collections.changed}
        </span>
      )}
      {summary.segments.map((segment, index) => (
        <div
          key={index}
          className={`text-xs whitespace-nowrap ${
            index === summary.segments.length - 1 ? "text-ink" : "text-ink-soft"
          }`}
        >
          <span className="tnum font-medium">{formatCurrency(segment.amount)}</span>{" "}
          <span className="text-ink-faint">{formatRanges(segment.ranges, MONTHS_SHORT)}</span>
        </div>
      ))}
    </div>
  );
}

"use client";

import { jsPDF } from "jspdf";
import autoTable, { type UserOptions } from "jspdf-autotable";
import { formatDateTime } from "@/lib/format";

/**
 * PDF export.
 *
 * Generated in the BROWSER with jsPDF rather than server-side.
 *
 * That is a deliberate choice for Vercel: headless-Chrome renderers
 * (puppeteer/playwright) blow past the serverless bundle limit and need a
 * custom runtime, and a server route would stream the whole report through the
 * function for no benefit. Client-side generation behaves identically in
 * development and in production, and costs the server nothing.
 *
 * CURRENCY NOTE: jsPDF's built-in fonts are WinAnsi-encoded, which has no
 * glyph for the taka sign (U+09F3) - it would render as a broken character.
 * PDFs therefore use the ASCII abbreviation "Tk", which is what Bangladeshi
 * invoices commonly print anyway. The CSV export carries a UTF-8 BOM and
 * handles the real symbol, and Bengali text, correctly.
 */

/** `1000` -> `"Tk 1,000"`. ASCII-safe for the built-in PDF fonts. */
export function pdfMoney(amount: number | null | undefined): string {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return "Tk 0";
  return `Tk ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Plain grouped number, for dense matrix cells where "Tk" on every cell is noise. */
export function pdfNumber(amount: number | null | undefined): string {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const BRAND: [number, number, number] = [37, 106, 191];
const INK: [number, number, number] = [33, 37, 45];
const MUTED: [number, number, number] = [110, 116, 128];

export interface PdfDocOptions {
  businessName: string;
  title: string;
  subtitle?: string;
  /** Rendered as "Label: value" lines under the title (filters, period, ...). */
  meta?: { label: string; value: string }[];
  orientation?: "portrait" | "landscape";
}

export interface PdfDoc {
  doc: jsPDF;
  /** Y position the next block should start at. */
  cursorY: number;
}

/** Creates a document with the business header block already drawn. */
export function createPdfDoc({
  businessName,
  title,
  subtitle,
  meta = [],
  orientation = "portrait",
}: PdfDocOptions): PdfDoc {
  const doc = new jsPDF({ orientation, unit: "pt", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const left = 40;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...BRAND);
  doc.text(businessName, left, 48);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.text(title, left, 68);

  let y = 84;
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text(subtitle, left, y);
    y += 14;
  }

  if (meta.length > 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    // Two columns of meta so a long filter list does not push the table down.
    const half = Math.ceil(meta.length / 2);
    meta.forEach((item, i) => {
      const col = i < half ? left : width / 2;
      const row = i < half ? i : i - half;
      doc.text(`${item.label}: ${item.value}`, col, y + row * 12);
    });
    y += Math.ceil(meta.length / 2) * 12 + 4;
  }

  // Generated-at stamp, right aligned on the title line.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(`Generated ${formatDateTime(new Date().toISOString())}`, width - left, 48, {
    align: "right",
  });

  doc.setDrawColor(225, 228, 233);
  doc.line(left, y, width - left, y);

  return { doc, cursorY: y + 14 };
}

/** Draws a table and returns the Y position just below it. */
export function addPdfTable(pdf: PdfDoc, options: UserOptions): number {
  autoTable(pdf.doc, {
    startY: pdf.cursorY,
    margin: { left: 40, right: 40 },
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: 4,
      textColor: INK,
      lineColor: [228, 231, 236],
      lineWidth: 0.5,
    },
    headStyles: {
      fillColor: [243, 245, 248],
      textColor: INK,
      fontStyle: "bold",
      fontSize: 8.5,
    },
    footStyles: {
      fillColor: [249, 250, 251],
      textColor: INK,
      fontStyle: "bold",
    },
    alternateRowStyles: { fillColor: [252, 253, 254] },
    ...options,
  });

  const last = (pdf.doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  return (last?.finalY ?? pdf.cursorY) + 18;
}

/** A compact label/value summary block, e.g. the financial totals. */
export function addPdfSummary(
  pdf: PdfDoc,
  rows: { label: string; value: string; strong?: boolean }[],
  startY: number,
): number {
  const { doc } = pdf;
  const left = 40;
  const width = doc.internal.pageSize.getWidth();
  let y = startY;

  doc.setFontSize(9);
  for (const row of rows) {
    doc.setFont("helvetica", row.strong ? "bold" : "normal");
    doc.setTextColor(...(row.strong ? INK : MUTED));
    doc.text(row.label, left, y);
    doc.setTextColor(...INK);
    doc.text(row.value, width - left, y, { align: "right" });
    y += 14;
  }

  doc.setDrawColor(225, 228, 233);
  doc.line(left, y - 8, width - left, y - 8);
  return y + 8;
}

/** Page numbers, then save. Called last so the page count is known. */
export function savePdf(pdf: PdfDoc, filename: string): void {
  const { doc } = pdf;
  const pages = doc.getNumberOfPages();
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();

  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`Page ${i} of ${pages}`, width / 2, height - 20, { align: "center" });
    doc.text("Amounts in Bangladeshi Taka (Tk)", 40, height - 20);
  }

  doc.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}

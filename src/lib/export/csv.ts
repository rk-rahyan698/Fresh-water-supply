"use client";

/**
 * CSV export.
 *
 * Deliberately dependency-free: a spreadsheet export is string building plus a
 * Blob download, and every XLSX library is a large addition for something the
 * accountant will open in Excel either way. CSV opens natively in Excel,
 * Sheets and LibreOffice, and works identically on Vercel because it never
 * touches the server.
 */

/** Escapes one CSV cell per RFC 4180. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Quote when the value contains a delimiter, quote or newline.
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

/**
 * Triggers a browser download.
 *
 * The BOM matters: without it Excel on Windows reads the file as ANSI and
 * mangles the taka sign and any Bengali client name.
 */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `Collection Report 2026 – Area 1.csv` -> a filename every OS accepts. */
export function safeFilename(parts: (string | number | null | undefined)[]): string {
  return parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== "")
    .join("-")
    .replace(/[^a-zA-Z0-9\-_ ]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

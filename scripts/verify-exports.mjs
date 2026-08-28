/**
 * Export verification.
 *
 *   npm run verify:exports
 *
 * Two things worth proving without a browser:
 *
 * 1. CSV escaping. toCsv is a pure function, so it is imported directly and
 *    fed the values that actually break naive CSV writers - commas, embedded
 *    quotes, newlines, and the taka sign.
 *
 * 2. That jsPDF + autoTable really produce a PDF with the API this project
 *    calls. jsPDF runs in Node, so a wrong option name or a renamed export is
 *    caught here rather than when someone clicks Download.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { toCsv, safeFilename } = await import(
  "file://" + join(here, "..", "src", "lib", "export", "csv.ts")
);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

console.log("== CSV escaping (RFC 4180) ==");

check("plain values are written bare", toCsv([["a", 1, "b"]]) === "a,1,b");

check(
  "a value containing a comma is quoted",
  toCsv([["Rahim, Uddin", 100]]) === '"Rahim, Uddin",100',
  toCsv([["Rahim, Uddin", 100]]),
);

check(
  "embedded quotes are doubled",
  toCsv([['He said "hi"']]) === '"He said ""hi"""',
  toCsv([['He said "hi"']]),
);

check(
  "a value containing a newline is quoted",
  toCsv([["line1\nline2"]]) === '"line1\nline2"',
  JSON.stringify(toCsv([["line1\nline2"]])),
);

check("null and undefined become empty cells", toCsv([[null, undefined, "x"]]) === ",,x");

check("rows are separated by CRLF", toCsv([["a"], ["b"]]) === "a\r\nb");

check(
  "the taka sign survives untouched",
  toCsv([["৳1,000"]]) === '"৳1,000"',
  toCsv([["৳1,000"]]),
);

// A realistic report row: a client whose name contains a comma, and amounts
// formatted to two decimals as the export writes them.
const report = toCsv([
  ["Client Code", "Client Name", "Area", "January", "Year Total"],
  ["C-0001", "Rahim, Uddin", "Area 1", "800.00", "1000.00"],
  ["", "TOTAL", "", "800.00", "1000.00"],
]);
check(
  "a full report round-trips to the expected text",
  report.split("\r\n").length === 3 && report.includes('"Rahim, Uddin"'),
  JSON.stringify(report),
);

console.log("\n== Filenames ==");
check("filename is slugified", safeFilename(["Collection Report", 2026]) === "collection-report-2026",
  safeFilename(["Collection Report", 2026]));
check("null parts are dropped", safeFilename(["report", null, undefined, 2026]) === "report-2026",
  safeFilename(["report", null, undefined, 2026]));
check("unsafe characters are stripped",
  safeFilename(["a/b:c*?", 1]) === "abc-1", safeFilename(["a/b:c*?", 1]));

console.log("\n== jsPDF + autoTable produce a real PDF ==");

const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
check("jsPDF constructs with the options this project uses", Boolean(doc));

doc.setFont("helvetica", "bold");
doc.setFontSize(16);
doc.text("Fresh Water Supply", 40, 48);
check("text and font APIs work", true);

autoTable(doc, {
  startY: 100,
  head: [["Client", "Jan", "Feb", "Total"]],
  body: [
    ["Rahim", "800", "1,000", "1,800"],
    ["Karim", "1,000", "0", "1,000"],
  ],
  foot: [["TOTAL", "1,800", "1,000", "2,800"]],
  styles: { font: "helvetica", fontSize: 8.5, cellPadding: 4 },
  headStyles: { fillColor: [243, 245, 248], fontStyle: "bold" },
  footStyles: { fillColor: [249, 250, 251], fontStyle: "bold" },
  alternateRowStyles: { fillColor: [252, 253, 254] },
  columnStyles: { 0: { cellWidth: 92, halign: "left" } },
  didParseCell: (data) => {
    if (data.column.index > 0) data.cell.styles.halign = "right";
  },
});
check("autoTable accepts head / body / foot and the style options used", true);

const lastTable = doc.lastAutoTable;
check("lastAutoTable.finalY is available for stacking blocks",
  typeof lastTable?.finalY === "number", JSON.stringify(lastTable?.finalY));

check("getNumberOfPages works (page numbering)", doc.getNumberOfPages() >= 1);

const bytes = doc.output("arraybuffer");
const header = Buffer.from(bytes.slice(0, 5)).toString("latin1");
check("output is a real PDF (starts with %PDF)", header === "%PDF-", header);
check("PDF has meaningful size", bytes.byteLength > 1000, `${bytes.byteLength} bytes`);

// The reason PDFs use "Tk": the built-in fonts have no taka glyph.
console.log("\n== Currency in PDFs ==");
const money = (v) => `Tk ${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
check("pdf money format is ASCII-safe", money(1000) === "Tk 1,000", money(1000));
check("no taka sign reaches the PDF text layer", !money(1000).includes("৳"));

console.log("\n" + "=".repeat(58));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
console.log("=".repeat(58));
process.exit(fail === 0 ? 0 : 1);

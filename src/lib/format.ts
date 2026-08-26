/**
 * Money and date formatting.
 *
 * Timezone rule: Postgres `date` columns (payment_date, billing_month,
 * submission_date) arrive as plain "YYYY-MM-DD" strings. We format them by
 * splitting the string, never via `new Date("2026-08-26")` - that parses as UTC
 * midnight and renders as the 25th for anyone west of Greenwich.
 *
 * Only true timestamps (created_at) go through Intl with an explicit
 * Asia/Dhaka timeZone.
 */

export const TIMEZONE = "Asia/Dhaka";
export const CURRENCY_SYMBOL = "৳"; // ৳ BENGALI RUPEE SIGN

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

const numberFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const numberFormat2dp = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `12500` -> `"৳12,500"`. Whole taka drop the decimals; paisa keep them. */
export function formatCurrency(amount: number | null | undefined): string {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return `${CURRENCY_SYMBOL}0`;
  return `${CURRENCY_SYMBOL}${numberFormat.format(value)}`;
}

/** Always two decimals - for receipts and reconciliation views. */
export function formatCurrencyExact(amount: number | null | undefined): string {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return `${CURRENCY_SYMBOL}0.00`;
  return `${CURRENCY_SYMBOL}${numberFormat2dp.format(value)}`;
}

/** Number without the symbol, for inputs and CSV-ish contexts. */
export function formatNumber(amount: number | null | undefined): string {
  return numberFormat.format(Number(amount ?? 0));
}

/** Rounds to 2dp the way the database does, avoiding float drift. */
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Dates - "YYYY-MM-DD" in, human text out                                     */
/* -------------------------------------------------------------------------- */

function parts(dateStr: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** `"2026-08-26"` -> `"26 Aug 2026"`. */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const p = parts(dateStr);
  if (!p) return dateStr;
  return `${p.d} ${MONTH_SHORT[p.m - 1]} ${p.y}`;
}

/** `"2026-08-26"` -> `"26 August 2026"`. */
export function formatDateLong(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const p = parts(dateStr);
  if (!p) return dateStr;
  return `${p.d} ${MONTH_NAMES[p.m - 1]} ${p.y}`;
}

/** `"2026-08-01"` -> `"August 2026"`. */
export function formatMonth(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const p = parts(dateStr);
  if (!p) return dateStr;
  return `${MONTH_NAMES[p.m - 1]} ${p.y}`;
}

/** `"2026-08-01"` -> `"Aug 2026"`, for charts and tight table cells. */
export function formatMonthShort(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const p = parts(dateStr);
  if (!p) return dateStr;
  return `${MONTH_SHORT[p.m - 1]} ${p.y}`;
}

/** Full timestamp rendered in Dhaka time, e.g. `"26 Aug 2026, 4:32 PM"`. */
export function formatDateTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  const datePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${datePart}, ${timePart}`;
}

/* -------------------------------------------------------------------------- */
/* "Now" according to Dhaka, not according to the server's clock               */
/* -------------------------------------------------------------------------- */

/** Today in Dhaka as `"YYYY-MM-DD"`. */
export function dhakaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** First day of the current Dhaka month as `"YYYY-MM-01"`. */
export function dhakaCurrentMonth(): string {
  return `${dhakaToday().slice(0, 7)}-01`;
}

/** Normalises any date string to the first of its month. */
export function toMonthStart(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

/** First day of the month `offset` months away (negative = past). */
export function shiftMonth(monthStr: string, offset: number): string {
  const p = parts(monthStr);
  if (!p) return monthStr;
  const total = p.y * 12 + (p.m - 1) + offset;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Last day of the given month as `"YYYY-MM-DD"`. */
export function monthEnd(monthStr: string): string {
  const p = parts(monthStr);
  if (!p) return monthStr;
  const lastDay = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Month options for dropdowns, newest first, ending at the current month.
 * `back` controls how far into the past the list reaches.
 */
export function monthOptions(back = 18): { value: string; label: string }[] {
  const current = dhakaCurrentMonth();
  return Array.from({ length: back }, (_, i) => {
    const value = shiftMonth(current, -i);
    return { value, label: formatMonth(value) };
  });
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/** Receipt/transaction number shown to users, e.g. `"WSB-000142"`. */
export function formatReceiptNo(receiptNo: number | null | undefined): string {
  if (receiptNo == null) return "-";
  return `WSB-${String(receiptNo).padStart(6, "0")}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

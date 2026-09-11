/**
 * Pure arithmetic for multi-month collection and the monthly-bill column.
 *
 * Deliberately free of `@/` imports and of React: scripts/verify-migration-
 * 0010.mjs loads this file directly with Node's type stripping, so the split a
 * collector sees on screen is the same code the test suite checks.
 *
 * Money is handled in whole paisa. `0.1 + 0.2` is not `0.3` in floating point,
 * and a split that is off by a paisa is an overpayment the database rejects.
 */

const toPaisa = (taka: number) => Math.round(taka * 100);
const toTaka = (paisa: number) => paisa / 100;

/* -------------------------------------------------------------------------- */
/* Splitting one amount across several unpaid months                           */
/* -------------------------------------------------------------------------- */

export interface UnpaidBill {
  /** "YYYY-MM-01" */
  billing_month: string;
  /** What is still owed on this bill, after adjustments and earlier payments. */
  due: number;
}

export interface Allocation {
  billing_month: string;
  amount: number;
}

export interface AllocationResult {
  /** Only months that receive something, oldest first. */
  allocations: Allocation[];
  /** Received beyond everything owed. Advance payments are not accepted. */
  unallocated: number;
}

/**
 * Oldest month first.
 *
 * Standard practice for arrears, and the business's choice: money clears the
 * oldest debt before newer bills, so an old month cannot sit unpaid
 * indefinitely while a client keeps paying the current one.
 *
 *   owes Jul 1000, Aug 1000, Sep 1000 - pays 2500
 *   -> Jul 1000, Aug 1000, Sep 500
 */
export function allocateOldestFirst(bills: UnpaidBill[], amount: number): AllocationResult {
  let remaining = Math.max(0, toPaisa(amount));
  const allocations: Allocation[] = [];

  const ordered = [...bills]
    .filter((bill) => toPaisa(bill.due) > 0)
    .sort((a, b) => a.billing_month.localeCompare(b.billing_month));

  for (const bill of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, toPaisa(bill.due));
    allocations.push({ billing_month: bill.billing_month, amount: toTaka(take) });
    remaining -= take;
  }

  return { allocations, unallocated: toTaka(remaining) };
}

/** Sum of allocations, without float drift. */
export function sumAllocations(allocations: Pick<Allocation, "amount">[]): number {
  return toTaka(allocations.reduce((sum, a) => sum + toPaisa(a.amount), 0));
}

/* -------------------------------------------------------------------------- */
/* The monthly bill across a year                                               */
/* -------------------------------------------------------------------------- */

/**
 * A run of months billed at the same amount.
 *
 * `ranges` holds month indexes (0 = January), inclusive. A segment can carry
 * more than one range when a gap interrupts the same amount - a client with no
 * bill in March but ৳1,000 either side is "৳1,000 Jan–Feb, Apr–Dec", never
 * "Jan–Dec", which would claim March was billed.
 */
export interface BillSegment {
  amount: number;
  ranges: [number, number][];
}

export interface BillMonthsSummary {
  segments: BillSegment[];
  /** True when more than one distinct amount was billed in the year. */
  changed: boolean;
  /** The most recent month's amount - the figure to lead with. */
  latest: number | null;
}

/**
 * Twelve monthly bill amounts (null = no bill) -> the segments to print.
 *
 * Segments stay in calendar order and are NOT merged by amount across a
 * different amount in between: ৳1,000 -> ৳1,200 -> ৳1,000 is three segments,
 * because that is the history.
 */
export function summariseBillMonths(amounts: (number | null)[]): BillMonthsSummary {
  const segments: BillSegment[] = [];
  let latest: number | null = null;

  amounts.forEach((raw, index) => {
    if (raw === null || raw === undefined) return;
    const amount = toTaka(toPaisa(Number(raw)));
    latest = amount;

    const last = segments[segments.length - 1];
    if (!last || toPaisa(last.amount) !== toPaisa(amount)) {
      segments.push({ amount, ranges: [[index, index]] });
      return;
    }

    const lastRange = last.ranges[last.ranges.length - 1];
    if (lastRange[1] === index - 1) {
      lastRange[1] = index;
    } else {
      last.ranges.push([index, index]);
    }
  });

  const distinct = new Set(segments.map((segment) => toPaisa(segment.amount)));
  return { segments, changed: distinct.size > 1, latest };
}

/**
 * `[[0,5],[8,11]]` -> `"Jan–Jun, Sep–Dec"`, given short month names.
 *
 * `dash` is an en dash on screen. The PDF passes "-": jsPDF's built-in fonts
 * are ASCII-safe only, which is also why PDFs print "Tk" rather than the taka
 * sign (see src/lib/export/pdf.ts).
 */
export function formatRanges(
  ranges: [number, number][],
  monthNames: readonly string[],
  dash = "–",
): string {
  return ranges
    .map(([from, to]) =>
      from === to ? monthNames[from] : `${monthNames[from]}${dash}${monthNames[to]}`,
    )
    .join(", ");
}

/** True when the segments cover every month of the year with one amount. */
export function isFlatFullYear(summary: BillMonthsSummary): boolean {
  if (summary.changed || summary.segments.length !== 1) return false;
  const ranges = summary.segments[0].ranges;
  return ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === 11;
}

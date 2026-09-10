import "server-only";

import { createClient } from "@/lib/supabase/server";
import { escapeLike } from "./clients";
import type {
  BillStatus,
  BillTotalsRow,
  CashSubmission,
  Client,
  MonthlyBill,
  Payment,
  PaymentDetail,
  PaymentMethod,
  PaymentTotals,
  Profile,
} from "@/types/database";

export const PAGE_SIZE = 25;

/* -------------------------------------------------------------------------- */
/* Collections                                                                 */
/* -------------------------------------------------------------------------- */

export interface PaymentFilters {
  from?: string;
  to?: string;
  billingMonth?: string;
  collectorId?: string;
  clientId?: string;
  /** Matches client name, code, phone or address. */
  search?: string;
  areaId?: string;
  method?: PaymentMethod;
  includeVoided?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PaymentListResult {
  payments: PaymentDetail[];
  total: number;
  page: number;
  pageCount: number;
  sum: number;
}

/**
 * A payment reaches its client through its bill.
 *
 * payments has no client_id of its own (see migration 0008: it would be
 * transitively dependent on monthly_bill_id, which is the 3NF violation the
 * column was removed for). So the embed nests, and `flattenPayment` below
 * lifts the client back to the top level for the view model - the UI keeps the
 * flat shape it always had, while the database stays normalised.
 */
const PAYMENT_SELECT =
  "*, monthly_bills!inner(id, billing_month, bill_amount, " +
  "clients!inner(id, name, client_code, area_id)), " +
  "collector:profiles!payments_collected_by_fkey(id, full_name)";

type NestedPaymentRow = Omit<PaymentDetail, "clients" | "monthly_bills"> & {
  monthly_bills:
    | (Pick<MonthlyBill, "id" | "billing_month" | "bill_amount"> & {
        clients: Pick<Client, "id" | "name" | "client_code" | "area_id"> | null;
      })
    | null;
};

function flattenPayment(row: NestedPaymentRow): PaymentDetail {
  const bill = row.monthly_bills;
  return {
    ...row,
    clients: bill?.clients ?? null,
    monthly_bills: bill
      ? { id: bill.id, billing_month: bill.billing_month, bill_amount: bill.bill_amount }
      : null,
  };
}

export async function listPayments(filters: PaymentFilters = {}): Promise<PaymentListResult> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  // !inner all the way down, so the billingMonth / client / area / search
  // filters below can reach into the embedded rows. Every payment always has a
  // bill and every bill a client, so this never drops rows.
  let query = supabase
    .from("payments")
    .select(PAYMENT_SELECT, { count: "exact" })
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  query = applyPaymentFilters(query, filters);

  const { data, error, count } = await query.overrideTypes<NestedPaymentRow[], { merge: false }>();
  if (error) throw error;

  const total = count ?? 0;
  return {
    payments: (data ?? []).map(flattenPayment),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sum: await sumPayments(filters),
  };
}

/**
 * Total for the *whole* filtered set, not just the page on screen - the owner
 * needs the real number under the table.
 *
 * Aggregated in the database (migration 0009), not by summing the rows here.
 * Selecting every match and adding the column up in JavaScript looked
 * equivalent and was not: Supabase caps a response at the project's "Max rows"
 * setting - 1000 by default - silently, so past a thousand payments this
 * returned the sum of the first thousand while the count beside it stayed
 * correct. The default view of /collections and both dashboards apply no date
 * filter, so they were all reachable.
 *
 * payment_totals() is SECURITY INVOKER, so RLS still scopes a collector to
 * their own payments exactly as the old query did.
 */
export async function sumPayments(filters: PaymentFilters = {}): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("payment_totals", {
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_billing_month: filters.billingMonth ?? null,
    p_collector_id: filters.collectorId ?? null,
    p_client_id: filters.clientId ?? null,
    p_area_id: filters.areaId ?? null,
    p_method: filters.method ?? null,
    // Raw, not escaped: like_escape() inside the function owns that, so a
    // client code containing % or _ cannot be double-escaped.
    p_search: filters.search?.trim() || null,
    p_include_voided: filters.includeVoided ?? false,
  });
  if (error) throw error;
  return Number((data as PaymentTotals | null)?.total_amount ?? 0);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- one narrow shim: the
   PostgREST builder generic differs between select() shapes, and this helper
   has to work against whichever one the paged query is built from. */
function applyPaymentFilters<T extends { eq: any; gte: any; lte: any; is: any; ilike: any }>(
  query: T,
  filters: PaymentFilters,
): T {
  let q: any = query;
  if (!filters.includeVoided) q = q.is("voided_at", null);
  if (filters.from) q = q.gte("payment_date", filters.from);
  if (filters.to) q = q.lte("payment_date", filters.to);
  if (filters.collectorId) q = q.eq("collected_by", filters.collectorId);
  // The client lives on the bill now, so every client-shaped filter goes one
  // level deeper than it used to.
  if (filters.clientId) q = q.eq("monthly_bills.client_id", filters.clientId);
  if (filters.method) q = q.eq("payment_method", filters.method);
  if (filters.billingMonth) q = q.eq("monthly_bills.billing_month", filters.billingMonth);
  if (filters.search?.trim()) {
    q = q.ilike("monthly_bills.clients.search_text", `%${escapeLike(filters.search.trim())}%`);
  }
  if (filters.areaId) q = q.eq("monthly_bills.clients.area_id", filters.areaId);
  return q as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ReceiptData = Payment & {
  clients: Pick<Client, "id" | "name" | "client_code" | "phone" | "address"> | null;
  monthly_bills: Pick<MonthlyBill, "id" | "billing_month" | "bill_amount" | "paid_amount" | "due_amount"> | null;
  collector: Pick<Profile, "id" | "full_name"> | null;
};

/** Same nesting as PAYMENT_SELECT, with the extra bill figures a receipt prints. */
type NestedReceiptRow = Omit<ReceiptData, "clients" | "monthly_bills"> & {
  monthly_bills:
    | (Pick<MonthlyBill, "id" | "billing_month" | "bill_amount" | "paid_amount" | "due_amount"> & {
        clients: Pick<Client, "id" | "name" | "client_code" | "phone" | "address"> | null;
      })
    | null;
};

export async function getPaymentReceipt(paymentId: string): Promise<ReceiptData | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payments")
    .select(
      "*, monthly_bills(id, billing_month, bill_amount, paid_amount, due_amount, " +
        "clients(id, name, client_code, phone, address)), " +
        "collector:profiles!payments_collected_by_fkey(id, full_name)",
    )
    .eq("id", paymentId)
    .maybeSingle()
    .overrideTypes<NestedReceiptRow, { merge: false }>();
  if (error) throw error;
  if (!data) return null;

  const bill = data.monthly_bills;
  return {
    ...data,
    clients: bill?.clients ?? null,
    monthly_bills: bill
      ? {
          id: bill.id,
          billing_month: bill.billing_month,
          bill_amount: bill.bill_amount,
          paid_amount: bill.paid_amount,
          due_amount: bill.due_amount,
        }
      : null,
  };
}

/**
 * How much had been paid against this bill *before* the given payment.
 * Receipts show "previously paid" so the client can see the running total.
 */
export async function getPaidBefore(billId: string, paymentId: string): Promise<number> {
  const supabase = await createClient();
  const { data: target, error: targetError } = await supabase
    .from("payments")
    .select("created_at")
    .eq("id", paymentId)
    .single();
  if (targetError) throw targetError;

  const { data, error } = await supabase
    .from("payments")
    .select("amount")
    .eq("monthly_bill_id", billId)
    .is("voided_at", null)
    .lt("created_at", target.created_at);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
}

/* -------------------------------------------------------------------------- */
/* Bills                                                                       */
/* -------------------------------------------------------------------------- */

export interface BillFilters {
  billingMonth: string;
  status?: BillStatus | "all";
  search?: string;
  areaId?: string;
  page?: number;
  pageSize?: number;
}

export type BillRow = MonthlyBill & {
  clients:
    | (Pick<Client, "id" | "name" | "client_code" | "phone" | "status" | "area_id"> & {
        areas: { name: string } | null;
      })
    | null;
};

export interface BillListResult {
  bills: BillRow[];
  total: number;
  page: number;
  pageCount: number;
  totals: BillTotals;
}

export interface BillTotals {
  /** Sum of bill_amount, before adjustments. */
  original: number;
  /** Sum of admin-approved discounts / waivers. */
  adjustment: number;
  /** Sum of adjusted_amount: paid + due always equals this. */
  billed: number;
  paid: number;
  due: number;
}

export async function listBills(filters: BillFilters): Promise<BillListResult> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  let query = supabase
    .from("monthly_bills")
    .select("*, clients!inner(id, name, client_code, phone, status, area_id, areas(name))", {
      count: "exact",
    })
    .eq("billing_month", filters.billingMonth)
    .order("due_amount", { ascending: false })
    .range(from, from + pageSize - 1);

  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }
  if (filters.areaId) {
    query = query.eq("clients.area_id", filters.areaId);
  }
  if (filters.search?.trim()) {
    query = query.ilike("clients.search_text", `%${escapeLike(filters.search.trim())}%`);
  }

  const { data, error, count } = await query.overrideTypes<BillRow[], { merge: false }>();
  if (error) throw error;

  return {
    bills: data ?? [],
    total: count ?? 0,
    page,
    pageCount: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
    totals: await sumBills(filters),
  };
}

/**
 * Month totals for the bills screen, aggregated in the database (0009).
 *
 * Same reason as sumPayments(): this used to select every bill for the month
 * and add the columns up here, which the API row cap truncates once the
 * business has more than a thousand clients - understating every figure on the
 * screen while the bill count stayed right.
 */
export async function sumBills(filters: BillFilters): Promise<BillTotals> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("bill_totals", {
    p_billing_month: filters.billingMonth,
    p_status: filters.status && filters.status !== "all" ? filters.status : null,
    p_area_id: filters.areaId ?? null,
    p_search: filters.search?.trim() || null,
  });
  if (error) throw error;

  const totals = data as BillTotalsRow | null;
  return {
    original: Number(totals?.original_amount ?? 0),
    adjustment: Number(totals?.adjustment_amount ?? 0),
    // `billed` is the ADJUSTED total, so paid + due always reconciles to it.
    billed: Number(totals?.adjusted_amount ?? 0),
    paid: Number(totals?.paid_amount ?? 0),
    due: Number(totals?.due_amount ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Cash submissions                                                            */
/* -------------------------------------------------------------------------- */

export type SubmissionRow = CashSubmission & {
  collector: Pick<Profile, "id" | "full_name"> | null;
  receiver: Pick<Profile, "id" | "full_name"> | null;
};

export interface SubmissionFilters {
  collectorId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listSubmissions(filters: SubmissionFilters = {}): Promise<SubmissionRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("cash_submissions")
    .select(
      "*, collector:profiles!cash_submissions_collector_id_fkey(id, full_name), " +
        "receiver:profiles!cash_submissions_received_by_fkey(id, full_name)",
    )
    .order("submission_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);

  if (filters.collectorId) query = query.eq("collector_id", filters.collectorId);
  if (filters.from) query = query.gte("submission_date", filters.from);
  if (filters.to) query = query.lte("submission_date", filters.to);

  const { data, error } = await query.overrideTypes<SubmissionRow[], { merge: false }>();
  if (error) throw error;
  return data ?? [];
}

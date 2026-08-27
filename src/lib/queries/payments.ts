import "server-only";

import { createClient } from "@/lib/supabase/server";
import { escapeLike } from "./clients";
import type {
  BillStatus,
  CashSubmission,
  Client,
  MonthlyBill,
  Payment,
  PaymentDetail,
  PaymentMethod,
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

export async function listPayments(filters: PaymentFilters = {}): Promise<PaymentListResult> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  // monthly_bills uses !inner so the billingMonth filter below can reach into
  // the embedded row. Every payment always has a bill, so this never drops rows.
  const select =
    "*, clients!inner(id, name, client_code, area_id), monthly_bills!inner(id, billing_month, bill_amount), " +
    "collector:profiles!payments_collected_by_fkey(id, full_name)";

  let query = supabase
    .from("payments")
    .select(select, { count: "exact" })
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  query = applyPaymentFilters(query, filters);

  const { data, error, count } = await query.overrideTypes<PaymentDetail[], { merge: false }>();
  if (error) throw error;

  const total = count ?? 0;
  return {
    payments: data ?? [],
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sum: await sumPayments(filters),
  };
}

/**
 * Total for the *whole* filtered set, not just the page on screen - the owner
 * needs the real number under the table.
 */
export async function sumPayments(filters: PaymentFilters = {}): Promise<number> {
  const supabase = await createClient();
  let query = supabase
    .from("payments")
    .select("amount, monthly_bills!inner(billing_month), clients!inner(search_text, area_id)");
  query = applyPaymentFilters(query, filters);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- one narrow shim: the
   PostgREST builder generic differs between select() shapes, and this helper is
   deliberately shared by both the paged query and the sum query. */
function applyPaymentFilters<T extends { eq: any; gte: any; lte: any; is: any; ilike: any }>(
  query: T,
  filters: PaymentFilters,
): T {
  let q: any = query;
  if (!filters.includeVoided) q = q.is("voided_at", null);
  if (filters.from) q = q.gte("payment_date", filters.from);
  if (filters.to) q = q.lte("payment_date", filters.to);
  if (filters.collectorId) q = q.eq("collected_by", filters.collectorId);
  if (filters.clientId) q = q.eq("client_id", filters.clientId);
  if (filters.method) q = q.eq("payment_method", filters.method);
  if (filters.billingMonth) q = q.eq("monthly_bills.billing_month", filters.billingMonth);
  if (filters.search?.trim()) {
    q = q.ilike("clients.search_text", `%${escapeLike(filters.search.trim())}%`);
  }
  if (filters.areaId) q = q.eq("clients.area_id", filters.areaId);
  return q as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ReceiptData = Payment & {
  clients: Pick<Client, "id" | "name" | "client_code" | "phone" | "address"> | null;
  monthly_bills: Pick<MonthlyBill, "id" | "billing_month" | "bill_amount" | "paid_amount" | "due_amount"> | null;
  collector: Pick<Profile, "id" | "full_name"> | null;
};

export async function getPaymentReceipt(paymentId: string): Promise<ReceiptData | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payments")
    .select(
      "*, clients(id, name, client_code, phone, address), " +
        "monthly_bills(id, billing_month, bill_amount, paid_amount, due_amount), " +
        "collector:profiles!payments_collected_by_fkey(id, full_name)",
    )
    .eq("id", paymentId)
    .maybeSingle()
    .overrideTypes<ReceiptData, { merge: false }>();
  if (error) throw error;
  return data;
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

export async function sumBills(filters: BillFilters): Promise<BillTotals> {
  const supabase = await createClient();
  let query = supabase
    .from("monthly_bills")
    .select(
      "bill_amount, adjustment_amount, adjusted_amount, paid_amount, due_amount, clients!inner(search_text, area_id)",
    )
    .eq("billing_month", filters.billingMonth);

  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }
  if (filters.areaId) {
    query = query.eq("clients.area_id", filters.areaId);
  }
  if (filters.search?.trim()) {
    query = query.ilike("clients.search_text", `%${escapeLike(filters.search.trim())}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).reduce<BillTotals>(
    (acc, row) => ({
      original: acc.original + Number(row.bill_amount),
      adjustment: acc.adjustment + Number(row.adjustment_amount),
      // `billed` is the ADJUSTED total, so paid + due always reconciles to it.
      billed: acc.billed + Number(row.adjusted_amount),
      paid: acc.paid + Number(row.paid_amount),
      due: acc.due + Number(row.due_amount),
    }),
    { original: 0, adjustment: 0, billed: 0, paid: 0, due: 0 },
  );
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

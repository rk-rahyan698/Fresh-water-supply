import "server-only";

import { createClient } from "@/lib/supabase/server";
import { dhakaCurrentMonth } from "@/lib/format";
import type {
  BillStatus,
  ClientStatus,
  ClientWithArea,
  ClientWithRate,
  MonthlyBill,
  Payment,
  Profile,
} from "@/types/database";

export const PAGE_SIZE = 25;

/**
 * `monthly_bill` is a PostgREST computed field, not a column (migration 0008).
 *
 * If it comes back missing, PostgREST has not picked up
 * `public.monthly_bill(public.clients)` - almost always because the schema
 * cache is stale after applying the migration. Silently rendering ৳0 on a
 * billing screen is the worst possible outcome, so say what is wrong instead.
 */
function assertRateField<T extends { monthly_bill?: unknown }>(row: T | null | undefined): void {
  if (row && row.monthly_bill === undefined) {
    throw new Error(
      "Supabase did not return the computed field `monthly_bill`. Apply " +
        "supabase/migrations/0008_normalize_3nf.sql, then reload the schema cache " +
        "(Supabase → API Docs → Reload, or `notify pgrst, 'reload schema';`).",
    );
  }
}

/** `%` and `_` are wildcards in ILIKE - neutralise them before interpolating. */
export function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export interface ClientListParams {
  search?: string;
  status?: ClientStatus | "all";
  areaId?: string;
  page?: number;
  pageSize?: number;
}

export interface ClientListResult {
  clients: ClientWithRate[];
  total: number;
  page: number;
  pageCount: number;
}

export async function listClients(params: ClientListParams = {}): Promise<ClientListResult> {
  const supabase = await createClient();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  // `monthly_bill` is a PostgREST computed field now, not a column, so "*"
  // does not include it - it has to be named. See migration 0008.
  let query = supabase
    .from("clients")
    .select("*, monthly_bill", { count: "exact" })
    .order("name", { ascending: true })
    .range(from, from + pageSize - 1);

  if (params.status && params.status !== "all") {
    query = query.eq("status", params.status);
  }
  if (params.areaId) {
    query = query.eq("area_id", params.areaId);
  }

  const search = params.search?.trim();
  if (search) {
    // One indexed lookup across name, code, phone and address.
    query = query.ilike("search_text", `%${escapeLike(search)}%`);
  }

  const { data, error, count } = await query.overrideTypes<ClientWithRate[], { merge: false }>();
  if (error) throw error;
  assertRateField(data?.[0]);

  const total = count ?? 0;
  return {
    clients: data ?? [],
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getClient(id: string): Promise<ClientWithArea | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*, monthly_bill, areas(id, name)")
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<ClientWithArea, { merge: false }>();
  if (error) throw error;
  assertRateField(data);
  return data;
}

/** A bill plus the admin who approved its adjustment, when there is one. */
export type ClientBill = MonthlyBill & {
  adjuster: Pick<Profile, "id" | "full_name"> | null;
};

/**
 * Every bill for a client, newest month first.
 *
 * The adjuster is embedded so the bill card can say who approved a discount.
 * RLS narrows profiles to the caller's own row for collectors, so they simply
 * see no name - which is fine, they cannot adjust bills anyway.
 */
export async function getClientBills(clientId: string, limit = 24): Promise<ClientBill[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("monthly_bills")
    .select("*, adjuster:profiles!monthly_bills_adjusted_by_fkey(id, full_name)")
    .eq("client_id", clientId)
    .order("billing_month", { ascending: false })
    .limit(limit)
    .overrideTypes<ClientBill[], { merge: false }>();
  if (error) throw error;
  return data ?? [];
}

export type ClientPayment = Payment & {
  collector: Pick<Profile, "id" | "full_name"> | null;
  monthly_bills: Pick<MonthlyBill, "billing_month"> | null;
};

/**
 * Payment history for a client.
 *
 * RLS narrows this to the caller's own payments when a collector is asking,
 * which is why the collector-facing client page labels it as such.
 */
export async function getClientPayments(clientId: string, limit = 50): Promise<ClientPayment[]> {
  const supabase = await createClient();
  // payments carries no client_id (0008) - the client is reached through the
  // bill, so the filter sits on the embedded row and the embed must be !inner
  // for it to apply.
  const { data, error } = await supabase
    .from("payments")
    .select(
      "*, collector:profiles!payments_collected_by_fkey(id, full_name), monthly_bills!inner(billing_month, client_id)",
    )
    .eq("monthly_bills.client_id", clientId)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit)
    .overrideTypes<ClientPayment[], { merge: false }>();
  if (error) throw error;
  return data ?? [];
}

/** The bill for one client in one month, or null if it has not been generated. */
export async function getClientBillForMonth(
  clientId: string,
  billingMonth: string,
): Promise<MonthlyBill | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("monthly_bills")
    .select("*")
    .eq("client_id", clientId)
    .eq("billing_month", billingMonth)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Total still owed by a client across every month. */
export async function getClientOutstanding(clientId: string): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("monthly_bills")
    .select("due_amount")
    .eq("client_id", clientId)
    .gt("due_amount", 0);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.due_amount), 0);
}

/** Next free client code, e.g. C-0007 - saves the owner inventing one. */
export async function suggestClientCode(): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("client_code")
    .ilike("client_code", "C-%")
    .order("client_code", { ascending: false })
    .limit(1);
  if (error) throw error;

  const last = data?.[0]?.client_code;
  const lastNumber = last ? Number(last.replace(/^C-/, "")) : 0;
  const next = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;
  return `C-${String(next).padStart(4, "0")}`;
}


/* -------------------------------------------------------------------------- */
/* Client list with this month's figures (spec section 24)                     */
/* -------------------------------------------------------------------------- */

export interface ClientOverviewRow {
  clientId: string;
  clientCode: string;
  name: string;
  phone: string | null;
  address: string | null;
  areaId: string | null;
  areaName: string | null;
  monthlyBill: number;
  clientStatus: ClientStatus;
  billId: string | null;
  billAmount: number | null;
  adjustmentAmount: number | null;
  adjustedAmount: number | null;
  paidAmount: number | null;
  dueAmount: number | null;
  billStatus: BillStatus | null;
}

export interface ClientOverviewResult {
  rows: ClientOverviewRow[];
  total: number;
  page: number;
  pageCount: number;
}

/**
 * Clients plus their bill for one month, in a single round trip.
 *
 * Doing this as one RPC rather than "list clients, then fetch each bill" is
 * what keeps the page flat as the client count grows.
 */
export async function listClientOverview(params: {
  month?: string;
  areaId?: string;
  search?: string;
  status?: ClientStatus | "all";
  page?: number;
  pageSize?: number;
} = {}): Promise<ClientOverviewResult> {
  const supabase = await createClient();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? PAGE_SIZE;

  const { data, error } = await supabase.rpc("client_month_overview", {
    p_month: params.month ?? dhakaCurrentMonth(),
    p_area_id: params.areaId ?? null,
    p_search: params.search?.trim() || null,
    p_status: params.status && params.status !== "all" ? params.status : null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw error;

  const rows = (data ?? []).map((row) => ({
    clientId: row.client_id,
    clientCode: row.client_code,
    name: row.name,
    phone: row.phone,
    address: row.address,
    areaId: row.area_id,
    areaName: row.area_name,
    monthlyBill: Number(row.monthly_bill),
    clientStatus: row.client_status,
    billId: row.bill_id,
    billAmount: row.bill_amount === null ? null : Number(row.bill_amount),
    adjustmentAmount: row.adjustment_amount === null ? null : Number(row.adjustment_amount),
    adjustedAmount: row.adjusted_amount === null ? null : Number(row.adjusted_amount),
    paidAmount: row.paid_amount === null ? null : Number(row.paid_amount),
    dueAmount: row.due_amount === null ? null : Number(row.due_amount),
    billStatus: row.bill_status,
  }));

  // total_count is a window function over the unpaginated set.
  const total = data && data.length > 0 ? Number(data[0].total_count) : 0;

  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/* -------------------------------------------------------------------------- */
/* Long-term bill history (spec sections 6-11)                                 */
/* -------------------------------------------------------------------------- */

export interface BillMatrixCell {
  billId: string;
  billingMonth: string;
  year: number;
  month: number;
  billAmount: number;
  adjustmentAmount: number;
  adjustedAmount: number;
  paidAmount: number;
  dueAmount: number;
  status: BillStatus;
  adjustmentType: string | null;
  adjustmentReason: string | null;
  paymentCount: number;
}

/** Years this client has bills for, newest first - powers the year selector. */
export async function getClientBillYears(clientId: string): Promise<number[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("client_bill_years", { p_client_id: clientId });
  if (error) throw error;
  return (data ?? []).map((row) => Number(row.bill_year));
}

/**
 * Bills for a bounded year range, flat. The UI pivots it into Year x Month.
 * Bounded so a client with a decade of history never ships it all at once.
 */
export async function getClientBillMatrix(
  clientId: string,
  fromYear: number,
  toYear: number,
): Promise<BillMatrixCell[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("client_bill_matrix", {
    p_client_id: clientId,
    p_from_year: fromYear,
    p_to_year: toYear,
  });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    billId: row.bill_id,
    billingMonth: row.billing_month,
    year: Number(row.bill_year),
    month: Number(row.bill_month),
    billAmount: Number(row.bill_amount),
    adjustmentAmount: Number(row.adjustment_amount),
    adjustedAmount: Number(row.adjusted_amount),
    paidAmount: Number(row.paid_amount),
    dueAmount: Number(row.due_amount),
    status: row.status,
    adjustmentType: row.adjustment_type,
    adjustmentReason: row.adjustment_reason,
    paymentCount: Number(row.payment_count),
  }));
}

/** Scheduled rate changes for a client, newest first (admin only via RLS). */
export async function getClientRateHistory(clientId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_rate_history")
    .select("*, changed_by_profile:profiles!client_rate_history_changed_by_fkey(full_name)")
    .eq("client_id", clientId)
    .order("effective_from", { ascending: false })
    .limit(24);
  if (error) throw error;
  return data ?? [];
}

/** Payments made against one specific bill - used by the bill detail dialog. */
export async function getBillPayments(billId: string): Promise<ClientPayment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payments")
    .select(
      "*, collector:profiles!payments_collected_by_fkey(id, full_name), monthly_bills(billing_month)",
    )
    .eq("monthly_bill_id", billId)
    .order("created_at", { ascending: true })
    .overrideTypes<ClientPayment[], { merge: false }>();
  if (error) throw error;
  return data ?? [];
}

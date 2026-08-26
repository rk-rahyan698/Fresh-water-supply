import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Client, ClientStatus, MonthlyBill, Payment, Profile } from "@/types/database";

export const PAGE_SIZE = 25;

/** `%` and `_` are wildcards in ILIKE - neutralise them before interpolating. */
export function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export interface ClientListParams {
  search?: string;
  status?: ClientStatus | "all";
  page?: number;
  pageSize?: number;
}

export interface ClientListResult {
  clients: Client[];
  total: number;
  page: number;
  pageCount: number;
}

export async function listClients(params: ClientListParams = {}): Promise<ClientListResult> {
  const supabase = await createClient();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  let query = supabase
    .from("clients")
    .select("*", { count: "exact" })
    .order("name", { ascending: true })
    .range(from, from + pageSize - 1);

  if (params.status && params.status !== "all") {
    query = query.eq("status", params.status);
  }

  const search = params.search?.trim();
  if (search) {
    // One indexed lookup across name, code, phone and address.
    query = query.ilike("search_text", `%${escapeLike(search)}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const total = count ?? 0;
  return {
    clients: data ?? [],
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getClient(id: string): Promise<Client | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
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
  const { data, error } = await supabase
    .from("payments")
    .select(
      "*, collector:profiles!payments_collected_by_fkey(id, full_name), monthly_bills(billing_month)",
    )
    .eq("client_id", clientId)
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

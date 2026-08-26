import "server-only";

import { createClient } from "@/lib/supabase/server";
import { escapeLike } from "./clients";
import { dhakaCurrentMonth, dhakaToday, monthEnd } from "@/lib/format";
import type {
  BillWithClient,
  CollectorStats,
  DashboardSummary,
  Profile,
} from "@/types/database";

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export async function getDashboardSummary(month?: string): Promise<DashboardSummary> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dashboard_summary", {
    p_month: month ?? dhakaCurrentMonth(),
  });
  if (error) throw error;
  // The RPC returns jsonb; this is the single place that shape is asserted.
  return data as unknown as DashboardSummary;
}

export interface MonthlySeriesPoint {
  billing_month: string;
  billed_amount: number;
  collected_amount: number;
  due_amount: number;
}

export async function getMonthlySeries(months = 6): Promise<MonthlySeriesPoint[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("monthly_series", { p_months: months });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    billing_month: row.billing_month,
    billed_amount: Number(row.billed_amount),
    collected_amount: Number(row.collected_amount),
    due_amount: Number(row.due_amount),
  }));
}

export interface CollectorSeriesPoint {
  collector_id: string;
  collector_name: string;
  payments_count: number;
  total_amount: number;
  cash_amount: number;
}

export async function getCollectorSeries(from?: string, to?: string): Promise<CollectorSeriesPoint[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("collector_series", {
    p_from: from ?? dhakaCurrentMonth(),
    p_to: to ?? dhakaToday(),
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    collector_id: row.collector_id,
    collector_name: row.collector_name,
    payments_count: Number(row.payments_count),
    total_amount: Number(row.total_amount),
    cash_amount: Number(row.cash_amount),
  }));
}

/* -------------------------------------------------------------------------- */
/* Collector figures                                                           */
/* -------------------------------------------------------------------------- */

export async function getCollectorStats(
  collectorId: string,
  month?: string,
): Promise<CollectorStats> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("collector_stats", {
    p_collector_id: collectorId,
    p_month: month ?? dhakaCurrentMonth(),
  });
  if (error) throw error;

  const raw = data as unknown as Record<string, string | number>;
  const num = (key: string) => Number(raw?.[key] ?? 0);

  return {
    collector_id: collectorId,
    today_collection: num("today_collection"),
    today_count: num("today_count"),
    month_collection: num("month_collection"),
    month_count: num("month_count"),
    total_collection: num("total_collection"),
    total_count: num("total_count"),
    cash_collection: num("cash_collection"),
    total_submitted: num("total_submitted"),
    unsubmitted: num("unsubmitted"),
  };
}

export interface DailyBreakdownRow {
  collection_date: string;
  payments_count: number;
  total_amount: number;
}

export async function getCollectorDailyBreakdown(
  collectorId: string,
  from: string,
  to: string,
): Promise<DailyBreakdownRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("collector_daily_breakdown", {
    p_collector_id: collectorId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    collection_date: row.collection_date,
    payments_count: Number(row.payments_count),
    total_amount: Number(row.total_amount),
  }));
}

/* -------------------------------------------------------------------------- */
/* Daily collection report                                                     */
/* -------------------------------------------------------------------------- */

export interface DailyCollectionRow {
  collector_id: string;
  collector_name: string;
  payments_count: number;
  total_amount: number;
}

export async function getDailyCollection(date: string): Promise<DailyCollectionRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("daily_collection_report", { p_date: date });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    collector_id: row.collector_id,
    collector_name: row.collector_name,
    payments_count: Number(row.payments_count),
    total_amount: Number(row.total_amount),
  }));
}

/* -------------------------------------------------------------------------- */
/* Due report                                                                  */
/* -------------------------------------------------------------------------- */

export type DueSort = "highest" | "oldest";

export interface DueReportFilters {
  billingMonth?: string | "all";
  search?: string;
  minDue?: number;
  sort?: DueSort;
  limit?: number;
}

export interface DueReportResult {
  rows: BillWithClient[];
  totalDue: number;
  count: number;
}

export async function getDueReport(filters: DueReportFilters = {}): Promise<DueReportResult> {
  const supabase = await createClient();
  const sort = filters.sort ?? "highest";

  let query = supabase
    .from("monthly_bills")
    .select("*, clients!inner(id, name, client_code, phone, address)")
    .gt("due_amount", 0)
    .limit(filters.limit ?? 500);

  if (filters.billingMonth && filters.billingMonth !== "all") {
    query = query.eq("billing_month", filters.billingMonth);
  }
  if (filters.minDue && filters.minDue > 0) {
    query = query.gte("due_amount", filters.minDue);
  }
  if (filters.search?.trim()) {
    query = query.ilike("clients.search_text", `%${escapeLike(filters.search.trim())}%`);
  }

  query =
    sort === "oldest"
      ? query.order("billing_month", { ascending: true }).order("due_amount", { ascending: false })
      : query.order("due_amount", { ascending: false }).order("billing_month", { ascending: true });

  const { data, error } = await query.overrideTypes<BillWithClient[], { merge: false }>();
  if (error) throw error;

  const rows = data ?? [];
  return {
    rows,
    totalDue: rows.reduce((sum, row) => sum + Number(row.due_amount), 0),
    count: rows.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Monthly report                                                              */
/* -------------------------------------------------------------------------- */

export interface MonthlyReport {
  billingMonth: string;
  activeClients: number;
  billCount: number;
  billedAmount: number;
  collectedAmount: number;
  dueAmount: number;
  unpaidCount: number;
  partialCount: number;
  paidCount: number;
  receivedInMonth: number;
  paymentsInMonth: number;
  collectors: CollectorSeriesPoint[];
}

export async function getMonthlyReport(billingMonth: string): Promise<MonthlyReport> {
  const [summary, collectors] = await Promise.all([
    getDashboardSummary(billingMonth),
    getCollectorSeries(billingMonth, monthEnd(billingMonth)),
  ]);

  return {
    billingMonth,
    activeClients: Number(summary.active_clients),
    billCount: Number(summary.bill_count),
    billedAmount: Number(summary.billed_amount),
    collectedAmount: Number(summary.collected_amount),
    dueAmount: Number(summary.due_amount),
    unpaidCount: Number(summary.unpaid_count),
    partialCount: Number(summary.partial_count),
    paidCount: Number(summary.paid_count),
    receivedInMonth: Number(summary.received_in_month),
    paymentsInMonth: Number(summary.payments_in_month),
    collectors,
  };
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export async function listUsers(): Promise<Profile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("role", { ascending: true })
    .order("full_name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Everyone who can hold cash: collectors and admins alike. */
export async function listCollectors(): Promise<Profile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("is_active", true)
    .order("full_name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

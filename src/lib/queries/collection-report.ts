import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  ClientFinancialSummary,
  CollectionSummary,
  PaymentMethod,
} from "@/types/database";

/* -------------------------------------------------------------------------- */
/* All-clients Client x Month collection report                                */
/* -------------------------------------------------------------------------- */

/**
 * What a month column means.
 *
 *   bill     paid TOWARD that month's bill, whenever it was paid (default).
 *            A client who pays August and September on 11 September reads
 *            AUG 500 / SEP 500 - both months visibly settled.
 *   payment  cash RECEIVED in that calendar month. The same client reads
 *            AUG 0 / SEP 1,000 - right for reconciling what came in during
 *            September, misleading as a picture of which months are paid.
 */
export type CollectionBasis = "bill" | "payment";

export interface CollectionMatrixRow {
  clientId: string;
  clientCode: string;
  clientName: string;
  areaId: string | null;
  areaName: string | null;
  /** Index 0 = January ... index 11 = December. 0 where nothing applies. */
  months: number[];
  /**
   * By billing month only: what is still due on each month's bill, null where
   * the client has no bill that month. Null altogether by payment date, where
   * a column is cash received and has no bill to owe on.
   */
  monthDue: (number | null)[] | null;
  yearTotal: number;
  /** By billing month only: still owed across the year's bills. */
  yearDue: number | null;
  paymentCount: number;
  /**
   * The bill amount actually billed for each month of the year, January first;
   * null where the client had no bill. Null altogether when the client had no
   * bills that year. See collection_bill_months() in migration 0010.
   */
  billMonths: (number | null)[] | null;
}

export interface CollectionFilters {
  year: number;
  areaId?: string;
  collectorId?: string;
  basis?: CollectionBasis;
}

/**
 * Years with bills or payments, newest first. Never hardcoded.
 *
 * Not payment_years(): by billing month a year matters as soon as it is
 * billed, and on 1 January nobody has paid the new year's bills yet.
 */
export async function getReportYears(): Promise<number[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("collection_report_years");
  if (error) throw error;
  return (data ?? []).map((row) => Number(row.report_year));
}

/**
 * Client x Month collection matrix, by billing month (default) or by payment
 * date. The pivot happens in SQL either way, so the browser receives one row
 * per client rather than every payment.
 */
export async function getCollectionMatrix(
  filters: CollectionFilters,
): Promise<CollectionMatrixRow[]> {
  const supabase = await createClient();
  const basis = filters.basis ?? "bill";
  const args = {
    p_year: filters.year,
    p_area_id: filters.areaId ?? null,
    p_collector_id: filters.collectorId ?? null,
  };

  // No collector filter on bill amounts: a bill is not collected by anyone.
  // Area only, which matches the bill ladder in collection_summary().
  const billedPromise = supabase.rpc("collection_bill_months", {
    p_year: filters.year,
    p_area_id: filters.areaId ?? null,
  });

  let rows: Omit<CollectionMatrixRow, "billMonths">[];
  if (basis === "bill") {
    const { data, error } = await supabase.rpc("collection_matrix_by_bill", args);
    if (error) throw error;
    rows = (data ?? []).map((row) => ({
      clientId: row.client_id,
      clientCode: row.client_code,
      clientName: row.client_name,
      areaId: row.area_id,
      areaName: row.area_name,
      months: row.paid_amounts.map((value) => (value === null ? 0 : Number(value))),
      monthDue: row.due_amounts.map((value) => (value === null ? null : Number(value))),
      yearTotal: Number(row.year_total),
      yearDue: Number(row.year_due),
      paymentCount: Number(row.payment_count),
    }));
  } else {
    const { data, error } = await supabase.rpc("collection_matrix", args);
    if (error) throw error;
    rows = (data ?? []).map((row) => ({
      clientId: row.client_id,
      clientCode: row.client_code,
      clientName: row.client_name,
      areaId: row.area_id,
      areaName: row.area_name,
      months: [
        Number(row.m01), Number(row.m02), Number(row.m03), Number(row.m04),
        Number(row.m05), Number(row.m06), Number(row.m07), Number(row.m08),
        Number(row.m09), Number(row.m10), Number(row.m11), Number(row.m12),
      ],
      monthDue: null,
      yearTotal: Number(row.year_total),
      yearDue: null,
      paymentCount: Number(row.payment_count),
    }));
  }

  const billed = await billedPromise;
  if (billed.error) throw billed.error;
  const billMonthsByClient = new Map(
    (billed.data ?? []).map((row) => [
      row.client_id,
      row.bill_amounts.map((value) => (value === null ? null : Number(value))),
    ]),
  );

  return rows.map((row) => ({ ...row, billMonths: billMonthsByClient.get(row.clientId) ?? null }));
}

export async function getCollectionSummary(
  filters: CollectionFilters,
): Promise<CollectionSummary> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("collection_summary", {
    p_year: filters.year,
    p_area_id: filters.areaId ?? null,
    p_collector_id: filters.collectorId ?? null,
  });
  if (error) throw error;

  const raw = (data ?? {}) as unknown as Record<string, string | number | null>;
  const num = (key: string) => Number(raw[key] ?? 0);

  return {
    year: num("year"),
    area_id: (raw.area_id as string) ?? null,
    collector_id: (raw.collector_id as string) ?? null,
    client_count: num("client_count"),
    total_collected: num("total_collected"),
    payment_count: num("payment_count"),
    paying_clients: num("paying_clients"),
    average_payment: num("average_payment"),
    original_amount: num("original_amount"),
    adjustment_amount: num("adjustment_amount"),
    adjusted_amount: num("adjusted_amount"),
    billed_collected: num("billed_collected"),
    outstanding: num("outstanding"),
    bill_count: num("bill_count"),
  };
}

/* -------------------------------------------------------------------------- */
/* One client's payment history                                                */
/* -------------------------------------------------------------------------- */

export interface ClientPaymentRow {
  paymentId: string;
  receiptNo: number;
  billingMonth: string;
  paymentDate: string;
  amount: number;
  paymentMethod: PaymentMethod;
  collectorName: string | null;
  notes: string | null;
  voided: boolean;
  voidReason: string | null;
}

/**
 * Full payment history for one client.
 *
 * RLS is bypassed inside the SECURITY DEFINER function, so it re-applies the
 * collector restriction itself: a collector sees only the payments they took.
 */
export async function getClientPaymentHistory(
  clientId: string,
  year?: number,
): Promise<ClientPaymentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("client_payment_history", {
    p_client_id: clientId,
    p_year: year ?? null,
    p_limit: 500,
  });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    paymentId: row.payment_id,
    receiptNo: Number(row.receipt_no),
    billingMonth: row.billing_month,
    paymentDate: row.payment_date,
    amount: Number(row.amount),
    paymentMethod: row.payment_method,
    collectorName: row.collector_name,
    notes: row.notes,
    voided: row.voided,
    voidReason: row.void_reason,
  }));
}

export async function getClientFinancialSummary(
  clientId: string,
  year?: number,
): Promise<ClientFinancialSummary> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("client_financial_summary", {
    p_client_id: clientId,
    p_year: year ?? null,
  });
  if (error) throw error;

  const raw = (data ?? {}) as unknown as Record<string, string | number | null>;
  const num = (key: string) => Number(raw[key] ?? 0);

  return {
    year: raw.year === null ? null : num("year"),
    paid_in_period: num("paid_in_period"),
    original_amount: num("original_amount"),
    adjustment_amount: num("adjustment_amount"),
    adjusted_amount: num("adjusted_amount"),
    collected_amount: num("collected_amount"),
    outstanding: num("outstanding"),
    bill_count: num("bill_count"),
  };
}

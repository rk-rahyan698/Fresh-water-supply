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

export interface CollectionMatrixRow {
  clientId: string;
  clientCode: string;
  clientName: string;
  areaId: string | null;
  areaName: string | null;
  /** Index 0 = January ... index 11 = December. */
  months: number[];
  yearTotal: number;
  paymentCount: number;
  /**
   * The bill amount actually billed for each month of the year, January first;
   * null where the client had no bill. Null altogether when the client had no
   * bills that year. Billing-month basis - unlike `months`, which follows the
   * payment date. See collection_bill_months() in migration 0010.
   */
  billMonths: (number | null)[] | null;
}

export interface CollectionFilters {
  year: number;
  areaId?: string;
  collectorId?: string;
}

/** Years that actually have payments, newest first. Never hardcoded. */
export async function getPaymentYears(): Promise<number[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("payment_years");
  if (error) throw error;
  return (data ?? []).map((row) => Number(row.payment_year));
}

/**
 * Client x Month collection matrix.
 *
 * Every cell is money actually collected in that calendar month
 * (payment_date basis) - not the bill amount, and never moved back to the
 * month the bill belongs to. The pivot happens in SQL, so the browser
 * receives one row per client rather than every payment.
 */
export async function getCollectionMatrix(
  filters: CollectionFilters,
): Promise<CollectionMatrixRow[]> {
  const supabase = await createClient();
  const [matrix, billed] = await Promise.all([
    supabase.rpc("collection_matrix", {
      p_year: filters.year,
      p_area_id: filters.areaId ?? null,
      p_collector_id: filters.collectorId ?? null,
    }),
    // No collector filter: a bill is not collected by anyone. Area only, which
    // matches the bill ladder in collection_summary().
    supabase.rpc("collection_bill_months", {
      p_year: filters.year,
      p_area_id: filters.areaId ?? null,
    }),
  ]);
  if (matrix.error) throw matrix.error;
  if (billed.error) throw billed.error;

  const billMonthsByClient = new Map(
    (billed.data ?? []).map((row) => [
      row.client_id,
      row.bill_amounts.map((value) => (value === null ? null : Number(value))),
    ]),
  );

  const data = matrix.data;
  return (data ?? []).map((row) => ({
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
    yearTotal: Number(row.year_total),
    paymentCount: Number(row.payment_count),
    billMonths: billMonthsByClient.get(row.client_id) ?? null,
  }));
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

"use server";

import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { getStaffNames } from "@/lib/queries/reports";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import type { AdjustmentType, BillStatus, PaymentMethod } from "@/types/database";

export interface BillDetailPayment {
  id: string;
  receiptNo: number;
  amount: number;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  collectorName: string | null;
  notes: string | null;
  voided: boolean;
  voidReason: string | null;
}

export interface BillDetail {
  billId: string;
  clientName: string;
  billingMonth: string;
  billAmount: number;
  adjustmentAmount: number;
  adjustedAmount: number;
  paidAmount: number;
  dueAmount: number;
  status: BillStatus;
  adjustmentType: AdjustmentType | null;
  adjustmentReason: string | null;
  approvedBy: string | null;
  payments: BillDetailPayment[];
}

/** Exactly what the select below returns; asserted once, at the boundary. */
interface BillDetailRow {
  id: string;
  billing_month: string;
  bill_amount: number;
  adjustment_amount: number;
  adjusted_amount: number;
  paid_amount: number;
  due_amount: number;
  status: BillStatus;
  adjustment_type: AdjustmentType | null;
  adjustment_reason: string | null;
  adjusted_by: string | null;
  clients: { name: string } | null;
  adjuster: { full_name: string } | null;
  payments: {
    id: string;
    receipt_no: number;
    collected_by: string;
    amount: number;
    payment_date: string;
    payment_method: PaymentMethod;
    notes: string | null;
    voided_at: string | null;
    void_reason: string | null;
    collector: { full_name: string } | null;
  }[];
}

/**
 * Loads one bill and its payments on demand.
 *
 * The bill history matrix shows up to 36 cells; fetching every cell's payments
 * up front would be the obvious way to make a ten-year client slow. This runs
 * only when a cell is actually opened (spec sections 10, 11).
 *
 * RLS still applies: a collector sees only the payments they took.
 */
export async function getBillDetailAction(billId: string): Promise<ActionResult<BillDetail>> {
  await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("monthly_bills")
    .select(
      "*, clients(name), adjuster:profiles!monthly_bills_adjusted_by_fkey(full_name), " +
        "payments(id, receipt_no, collected_by, amount, payment_date, payment_method, notes, voided_at, void_reason, " +
        "collector:profiles!payments_collected_by_fkey(full_name))",
    )
    .eq("id", billId)
    .maybeSingle()
    .overrideTypes<BillDetailRow, { merge: false }>();

  if (error) return actionError(error);
  if (!data) return actionError("Bill not found.");

  const row = data;

  // A collector's RLS hides the owner's profile, so "Approved by" embeds as
  // null for them. Look up whichever names the embeds could not see.
  let names: Map<string, string>;
  try {
    names = await getStaffNames([
      row.adjuster ? null : row.adjusted_by,
      ...(row.payments ?? []).map((p) => (p.collector ? null : p.collected_by)),
    ]);
  } catch (lookupError) {
    return actionError(lookupError);
  }

  return actionOk({
    billId: row.id,
    clientName: row.clients?.name ?? "-",
    billingMonth: row.billing_month,
    billAmount: Number(row.bill_amount),
    adjustmentAmount: Number(row.adjustment_amount),
    adjustedAmount: Number(row.adjusted_amount),
    paidAmount: Number(row.paid_amount),
    dueAmount: Number(row.due_amount),
    status: row.status,
    adjustmentType: row.adjustment_type,
    adjustmentReason: row.adjustment_reason,
    approvedBy: row.adjuster?.full_name ?? (row.adjusted_by ? names.get(row.adjusted_by) : null) ?? null,
    payments: (row.payments ?? [])
      .map((p) => ({
        id: p.id,
        receiptNo: p.receipt_no,
        amount: Number(p.amount),
        paymentDate: p.payment_date,
        paymentMethod: p.payment_method,
        collectorName: p.collector?.full_name ?? names.get(p.collected_by) ?? null,
        notes: p.notes,
        voided: p.voided_at !== null,
        voidReason: p.void_reason,
      }))
      .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate)),
  });
}

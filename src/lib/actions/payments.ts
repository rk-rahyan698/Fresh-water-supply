"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin, requireUser } from "@/lib/auth";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import {
  billAdjustmentSchema,
  billAmountSchema,
  generateBillsSchema,
  generateClientBillSchema,
  paymentSchema,
  voidPaymentSchema,
} from "@/lib/validations/payment";
import { fieldErrorsFrom } from "@/lib/validations/shared";
import type { MonthlyBill, Payment } from "@/types/database";

function revalidateMoney(clientId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/collections");
  revalidatePath("/bills");
  revalidatePath("/reports/due");
  revalidatePath("/reports/monthly");
  revalidatePath("/reports/daily");
  revalidatePath("/reports/collector");
  revalidatePath("/submissions");
  revalidatePath("/my/dashboard");
  revalidatePath("/my/collections");
  if (clientId) {
    revalidatePath(`/clients/${clientId}`);
    revalidatePath(`/my/clients/${clientId}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Collecting money                                                            */
/* -------------------------------------------------------------------------- */

type PaymentState = ActionResult<{ paymentId: string; receiptNo: number }> | null;

export async function recordPaymentAction(
  _prev: PaymentState,
  formData: FormData,
): Promise<PaymentState> {
  // Any active user may collect; the SQL function stamps collected_by from the
  // JWT, so a collector cannot record a payment under someone else's name.
  await requireUser();

  const parsed = paymentSchema.safeParse({
    client_id: formData.get("client_id"),
    billing_month: formData.get("billing_month"),
    amount: formData.get("amount"),
    payment_method: formData.get("payment_method") ?? "cash",
    payment_date: (formData.get("payment_date") as string) || undefined,
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const values = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("record_payment", {
    p_client_id: values.client_id,
    p_billing_month: values.billing_month,
    p_amount: values.amount,
    p_payment_method: values.payment_method,
    p_notes: values.notes ?? null,
    p_payment_date: values.payment_date ?? null,
  });

  if (error) return actionError(error);

  const payment = data as unknown as Payment;
  revalidateMoney(values.client_id);
  return actionOk({ paymentId: payment.id, receiptNo: payment.receipt_no });
}

type VoidState = ActionResult<null> | null;

export async function voidPaymentAction(_prev: VoidState, formData: FormData): Promise<VoidState> {
  await requireAdmin();

  const parsed = voidPaymentSchema.safeParse({
    payment_id: formData.get("payment_id"),
    reason: formData.get("reason"),
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("void_payment", {
    p_payment_id: parsed.data.payment_id,
    p_reason: parsed.data.reason,
  });

  if (error) return actionError(error);

  const payment = data as unknown as Payment;
  revalidateMoney(payment.client_id);
  return actionOk(null);
}

/* -------------------------------------------------------------------------- */
/* Bills                                                                       */
/* -------------------------------------------------------------------------- */

type GenerateState = ActionResult<{
  created: number;
  skipped: number;
  billed: number;
  month: string;
}> | null;

export async function generateBillsAction(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  await requireAdmin();

  const parsed = generateBillsSchema.safeParse({
    billing_month: formData.get("billing_month"),
  });

  if (!parsed.success) {
    return actionError("Select a month first.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_monthly_bills", {
    p_billing_month: parsed.data.billing_month,
  });

  if (error) return actionError(error);

  const result = data?.[0];
  revalidateMoney();
  return actionOk({
    created: Number(result?.created_count ?? 0),
    skipped: Number(result?.skipped_count ?? 0),
    billed: Number(result?.billed_amount ?? 0),
    month: parsed.data.billing_month,
  });
}

export async function generateClientBillAction(
  clientId: string,
  billingMonth: string,
): Promise<ActionResult<{ billId: string }>> {
  await requireAdmin();

  const parsed = generateClientBillSchema.safeParse({
    client_id: clientId,
    billing_month: billingMonth,
  });
  if (!parsed.success) return actionError("Select a valid month.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_client_bill", {
    p_client_id: parsed.data.client_id,
    p_billing_month: parsed.data.billing_month,
  });

  if (error) return actionError(error);

  const bill = data as unknown as MonthlyBill;
  revalidateMoney(clientId);
  return actionOk({ billId: bill.id });
}

export async function updateBillAmountAction(
  billId: string,
  billAmount: string | number,
): Promise<ActionResult<null>> {
  await requireAdmin();

  const parsed = billAmountSchema.safeParse({ bill_id: billId, bill_amount: billAmount });
  if (!parsed.success) return actionError("Enter a valid amount.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_bill_amount", {
    p_bill_id: parsed.data.bill_id,
    p_bill_amount: parsed.data.bill_amount,
  });

  if (error) return actionError(error);

  const bill = data as unknown as MonthlyBill;
  revalidateMoney(bill.client_id);
  return actionOk(null);
}

/* -------------------------------------------------------------------------- */
/* Bill adjustments - discount / waiver                                        */
/*                                                                             */
/* Admin only. A collector must never be able to quietly reduce a bill, so     */
/* requireAdmin() runs here AND set_bill_adjustment() re-checks the role from  */
/* the JWT, stamping adjusted_by itself rather than trusting the form.         */
/* -------------------------------------------------------------------------- */

type AdjustmentState = ActionResult<{ billId: string }> | null;

export async function setBillAdjustmentAction(
  _prev: AdjustmentState,
  formData: FormData,
): Promise<AdjustmentState> {
  await requireAdmin();

  const parsed = billAdjustmentSchema.safeParse({
    bill_id: formData.get("bill_id"),
    adjustment_amount: formData.get("adjustment_amount"),
    adjustment_type: formData.get("adjustment_type"),
    adjustment_reason: formData.get("adjustment_reason"),
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_bill_adjustment", {
    p_bill_id: parsed.data.bill_id,
    p_adjustment_amount: parsed.data.adjustment_amount,
    p_adjustment_type: parsed.data.adjustment_type,
    p_adjustment_reason: parsed.data.adjustment_reason,
  });

  if (error) return actionError(error);

  const bill = data as unknown as MonthlyBill;
  revalidateMoney(bill.client_id);
  return actionOk({ billId: bill.id });
}

export async function removeBillAdjustmentAction(
  billId: string,
): Promise<ActionResult<null>> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_bill_adjustment", {
    p_bill_id: billId,
  });

  if (error) return actionError(error);

  const bill = data as unknown as MonthlyBill;
  revalidateMoney(bill.client_id);
  return actionOk(null);
}

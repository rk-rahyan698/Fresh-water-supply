import { z } from "zod";
import { dateString, moneyAmount, monthString, optionalText, uuid } from "./shared";

export const paymentMethodSchema = z.enum(["cash", "bank", "mobile_banking", "other"]);

export const paymentSchema = z.object({
  client_id: uuid,
  billing_month: monthString,
  amount: moneyAmount,
  payment_method: paymentMethodSchema.default("cash"),
  payment_date: dateString.optional(),
  notes: optionalText(300),
});

export type PaymentInput = z.input<typeof paymentSchema>;
export type PaymentValues = z.output<typeof paymentSchema>;

export const voidPaymentSchema = z.object({
  payment_id: uuid,
  reason: z
    .string()
    .trim()
    .min(3, "Give a short reason (at least 3 characters)")
    .max(300, "Reason is too long"),
});

export const billAmountSchema = z.object({
  bill_id: uuid,
  bill_amount: z
    .union([z.string(), z.number()])
    .transform((value) =>
      typeof value === "number" ? value : Number(value.replace(/[,\s৳]/g, "")),
    )
    .refine((value) => Number.isFinite(value) && value >= 0, "Enter a valid amount")
    .transform((value) => Math.round(value * 100) / 100),
});

export const generateBillsSchema = z.object({
  billing_month: monthString,
});

export const generateClientBillSchema = z.object({
  client_id: uuid,
  billing_month: monthString,
});

/* -------------------------------------------------------------------------- */
/* Bill adjustments - discount / waiver (admin only)                           */
/* -------------------------------------------------------------------------- */

export const adjustmentTypeSchema = z.enum([
  "discount",
  "waiver",
  "special_reduction",
  "other",
]);

/**
 * An adjustment ALWAYS carries a type and a reason. The owner has to be able to
 * look back and understand why a bill was reduced, so the reason is required
 * here, in the SQL function, and by a CHECK constraint on the table.
 */
export const billAdjustmentSchema = z.object({
  bill_id: uuid,
  adjustment_amount: moneyAmount,
  adjustment_type: adjustmentTypeSchema,
  adjustment_reason: z
    .string()
    .trim()
    .min(3, "Give a reason (at least 3 characters)")
    .max(300, "Reason is too long"),
});

export type BillAdjustmentInput = z.input<typeof billAdjustmentSchema>;

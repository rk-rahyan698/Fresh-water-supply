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

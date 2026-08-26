import { z } from "zod";

/** "YYYY-MM-DD" as produced by <input type="date"> and Postgres date columns. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");

/** A billing month, always normalised to the first of the month. */
export const monthString = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Select a month")
  .transform((value) => `${value.slice(0, 7)}-01`);

/**
 * Money coming out of a text input.
 *
 * Strips thousands separators and the taka sign so "৳1,000" pastes cleanly,
 * then enforces 2 decimal places to match numeric(12,2).
 */
export const moneyAmount = z
  .union([z.string(), z.number()])
  .transform((value) =>
    typeof value === "number" ? value : Number(value.replace(/[,\s৳]/g, "")),
  )
  .refine((value) => Number.isFinite(value), "Enter a valid amount")
  .refine((value) => value > 0, "Enter an amount greater than zero")
  .refine((value) => value <= 99_999_999, "That amount is too large")
  .transform((value) => Math.round(value * 100) / 100);

/** Like moneyAmount but allows zero - used for a client's monthly rate. */
export const moneyAmountOrZero = z
  .union([z.string(), z.number()])
  .transform((value) =>
    typeof value === "number" ? value : Number(value.replace(/[,\s৳]/g, "")),
  )
  .refine((value) => Number.isFinite(value), "Enter a valid amount")
  .refine((value) => value >= 0, "Amount cannot be negative")
  .refine((value) => value <= 99_999_999, "That amount is too large")
  .transform((value) => Math.round(value * 100) / 100);

/** Trims, and turns "" into undefined so empty inputs become NULL. */
export const optionalText = (max = 500) =>
  z
    .string()
    .max(max, `Keep this under ${max} characters`)
    .transform((value) => value.trim())
    .transform((value) => (value === "" ? undefined : value))
    .optional();

export const uuid = z.string().uuid("Invalid identifier");

/** Collapses a Zod error into `{ fieldName: "message" }` for form display. */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "form";
    if (!result[key]) result[key] = issue.message;
  }
  return result;
}

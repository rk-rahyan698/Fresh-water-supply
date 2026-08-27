import { z } from "zod";
import { monthString, moneyAmountOrZero, optionalText, uuid } from "./shared";

export const areaSchema = z.object({
  id: uuid.optional().nullable(),
  name: z
    .string()
    .trim()
    .min(1, "Area name is required")
    .max(60, "Keep the name under 60 characters"),
  description: optionalText(300),
  is_active: z.boolean(),
});

export type AreaInput = z.input<typeof areaSchema>;

export const clientAreaSchema = z.object({
  client_id: uuid,
  /** Empty string means "no area" - clients may be unassigned. */
  area_id: uuid.nullable().optional(),
});

/**
 * A scheduled rate change (spec section 2).
 *
 * The effective month is required and validated again in SQL, where it also
 * cannot be earlier than the current month - so an already-billed month can
 * never be re-rated.
 */
export const clientRateSchema = z.object({
  client_id: uuid,
  monthly_bill: moneyAmountOrZero,
  effective_from: monthString,
  reason: optionalText(300),
});

export type ClientRateInput = z.input<typeof clientRateSchema>;

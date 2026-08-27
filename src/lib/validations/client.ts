import { z } from "zod";
import { dateString, moneyAmountOrZero, optionalText, uuid } from "./shared";

export const clientSchema = z.object({
  id: uuid.optional().nullable(),
  client_code: z
    .string()
    .trim()
    .min(1, "Client code is required")
    .max(24, "Keep the code under 24 characters")
    .regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers and dashes only")
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  phone: z
    .string()
    .trim()
    .max(24, "Phone number is too long")
    .refine(
      (value) => value === "" || /^[0-9+\-\s()]{6,}$/.test(value),
      "Enter a valid phone number",
    )
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
  address: optionalText(300),
  monthly_bill: moneyAmountOrZero,
  area_id: uuid.nullable().optional(),
  start_date: dateString,
  status: z.enum(["active", "inactive"]),
  notes: optionalText(1000),
});

export type ClientInput = z.input<typeof clientSchema>;
export type ClientValues = z.output<typeof clientSchema>;

export const clientStatusSchema = z.object({
  client_id: uuid,
  status: z.enum(["active", "inactive"]),
});

import { z } from "zod";
import { optionalText, uuid } from "./shared";

const phone = z
  .string()
  .trim()
  .max(24, "Phone number is too long")
  .refine((value) => value === "" || /^[0-9+\-\s()]{6,}$/.test(value), "Enter a valid phone number")
  .transform((value) => (value === "" ? undefined : value))
  .optional();

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.input<typeof loginSchema>;

export const createUserSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(72, "Password is too long"),
  full_name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  phone,
  role: z.enum(["admin", "collector"]),
});

export const updateUserSchema = z.object({
  user_id: uuid,
  full_name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  phone,
  role: z.enum(["admin", "collector"]),
  is_active: z.boolean(),
});

export const ownProfileSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  phone,
});

export const resetPasswordSchema = z.object({
  user_id: uuid,
  password: z.string().min(8, "Use at least 8 characters").max(72, "Password is too long"),
});

export const notesSchema = optionalText(300);

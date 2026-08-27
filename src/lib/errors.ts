import { formatCurrency } from "@/lib/format";

/**
 * Turns database and auth errors into sentences a collector can act on.
 *
 * The SQL functions raise stable uppercase tokens ("PAYMENT_EXCEEDS_DUE|500.00")
 * precisely so this layer can translate them. A raw Postgres message must never
 * reach the screen.
 */

type Detail = string | undefined;

const MESSAGES: Record<string, (detail: Detail) => string> = {
  AUTH_REQUIRED: () => "Please sign in again.",
  USER_INACTIVE: () => "Your account has been deactivated. Please contact the owner.",
  ADMIN_ONLY: () => "Only the owner can do that.",
  CANNOT_DEMOTE_SELF: () => "You cannot change your own role or deactivate yourself.",
  LAST_ADMIN: () => "This is the last active admin. Promote someone else first.",

  INVALID_AMOUNT: () => "Enter an amount greater than zero.",
  NAME_REQUIRED: () => "Name is required.",
  CLIENT_CODE_REQUIRED: () => "Client code is required.",
  VOID_REASON_REQUIRED: () => "Please give a reason for voiding this payment.",

  BILL_NOT_FOUND: () =>
    "No bill exists for this client for the selected month. Ask the owner to generate it first.",
  BILL_ALREADY_EXISTS: () => "A bill already exists for this client for that month.",
  BILL_ALREADY_PAID: () => "This bill is already fully paid.",
  BILL_BELOW_PAID: (d) =>
    `The bill cannot be less than the ${formatCurrency(Number(d))} already collected against it.`,
  FUTURE_BILLING_MONTH: () => "You cannot generate bills for a future month.",
  BILL_BELOW_ADJUSTMENT: (d) =>
    `The bill cannot be less than the ${formatCurrency(Number(d))} adjustment already applied to it.`,

  ADJUSTMENT_REASON_REQUIRED: () => "Please give a reason for this adjustment.",
  ADJUSTMENT_TYPE_REQUIRED: () => "Please choose an adjustment type.",
  ADJUSTMENT_EXCEEDS_BILL: (d) =>
    `An adjustment cannot be more than the bill itself (${formatCurrency(Number(d))}).`,
  ADJUSTMENT_BELOW_PAID: (d) =>
    `That would waive money already collected. The most you can adjust is ${formatCurrency(Number(d))}. Void a payment first if you need to go further.`,

  PAYMENT_EXCEEDS_DUE: (d) =>
    `That is more than the outstanding due of ${formatCurrency(Number(d))}. Overpayment is not allowed.`,
  PAYMENT_NOT_FOUND: () => "Payment not found.",
  PAYMENT_ALREADY_VOIDED: () => "This payment has already been voided.",
  PAYMENT_IMMUTABLE: () => "Payments cannot be edited. Void the payment and record a new one.",
  PAYMENT_DELETE_FORBIDDEN: () => "Payments cannot be deleted. Void it instead.",
  FUTURE_PAYMENT_DATE: () => "A payment cannot be dated in the future.",

  SUBMISSION_EXCEEDS_COLLECTED: (d) =>
    `That is more than the ${formatCurrency(Number(d))} this collector still holds.`,
  FUTURE_SUBMISSION_DATE: () => "A submission cannot be dated in the future.",
  COLLECTOR_NOT_FOUND: () => "Collector not found.",

  AREA_NAME_REQUIRED: () => "Area name is required.",
  AREA_NOT_FOUND: () => "Area not found.",
  AREA_HAS_CLIENTS: (d) =>
    `That area still has ${d ?? "some"} client(s). Move them elsewhere first, or just deactivate the area.`,
  RATE_EFFECTIVE_IN_PAST: () =>
    "A rate change can only take effect from the current month onwards - months already billed keep their amount.",

  CLIENT_NOT_FOUND: () => "Client not found.",
  CLIENT_INACTIVE: () => "This client is inactive. Activate them before creating a bill.",
  CLIENT_HAS_PAYMENTS: () =>
    "This client has payment history and cannot be deleted. Deactivate them instead.",
  USER_NOT_FOUND: () => "User not found.",
};

/** Postgres SQLSTATE codes we can phrase better than Supabase does. */
const SQLSTATE_MESSAGES: Record<string, string> = {
  "23505": "That value is already taken. Please use a different one.",
  "23503": "That record is still referenced elsewhere and cannot be removed.",
  "23514": "Those values are not allowed.",
  "42501": "You do not have permission to do that.",
  PGRST301: "Your session expired. Please sign in again.",
};

interface MaybeSupabaseError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

/**
 * `"PAYMENT_EXCEEDS_DUE|500.00"` -> friendly sentence.
 * Anything unrecognised falls back to a generic message rather than leaking SQL.
 */
export function toFriendlyMessage(error: unknown): string {
  const err = (error ?? {}) as MaybeSupabaseError;
  const raw = typeof err.message === "string" ? err.message : "";

  // Our own tokens, optionally carrying a "|detail" payload.
  const tokenMatch = /([A-Z_]{4,})(?:\|([^\s]*))?/.exec(raw);
  if (tokenMatch) {
    const handler = MESSAGES[tokenMatch[1]];
    if (handler) return handler(tokenMatch[2]);
  }

  if (err.code && SQLSTATE_MESSAGES[err.code]) {
    // Unique violation on client_code is worth naming explicitly.
    if (err.code === "23505" && /client_code/.test(`${err.details ?? ""}${raw}`)) {
      return "That client code is already used by another client.";
    }
    if (err.code === "23505" && /client_month/.test(`${err.details ?? ""}${raw}`)) {
      return "A bill already exists for this client for that month.";
    }
    return SQLSTATE_MESSAGES[err.code];
  }

  // Supabase Auth phrasings.
  if (/invalid login credentials/i.test(raw)) return "Wrong email or password.";
  if (/email not confirmed/i.test(raw)) return "This account is not confirmed yet.";
  if (/user already registered|already been registered/i.test(raw)) {
    return "An account with that email already exists.";
  }
  if (/password should be at least/i.test(raw)) return "Password must be at least 8 characters.";
  if (/rate limit|too many requests/i.test(raw)) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    return "Network problem. Check your connection and try again.";
  }

  return "Something went wrong. Please try again.";
}

/* -------------------------------------------------------------------------- */
/* Server action result envelope                                               */
/* -------------------------------------------------------------------------- */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function actionError(
  error: unknown,
  fieldErrors?: Record<string, string>,
): ActionResult<never> {
  return {
    ok: false,
    error: typeof error === "string" ? error : toFriendlyMessage(error),
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

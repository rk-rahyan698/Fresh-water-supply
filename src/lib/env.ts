/**
 * Environment access with clear failure messages.
 *
 * A missing Supabase URL should say so plainly rather than surfacing as an
 * "Invalid URL" stack trace three layers down.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in ` +
        `(see README "Setup"). On Vercel, add it under Project Settings -> Environment Variables.`,
    );
  }
  return value.trim();
}

export const env = {
  get supabaseUrl(): string {
    return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get supabaseAnonKey(): string {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
  /** Server-only. Never import this from a client component. */
  get supabaseServiceRoleKey(): string {
    return required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  },
  get businessName(): string {
    return process.env.NEXT_PUBLIC_BUSINESS_NAME?.trim() || "Water Supply Business";
  },
};

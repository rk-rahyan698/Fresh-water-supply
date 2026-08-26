import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only used where the anon key genuinely cannot do the job - creating and
 * deleting auth users from the admin "Users" screen. Every caller must do its
 * own `requireAdmin()` check first.
 *
 * `import "server-only"` above makes the build fail if this ever gets pulled
 * into a client bundle.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

import { requireAdmin } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { env } from "@/lib/env";

/**
 * Role gate for every admin route.
 *
 * This is convenience, not security - RLS and the SECURITY DEFINER functions
 * reject a collector's request even if they reach the URL directly.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAdmin();

  return (
    <AppShell role="admin" userName={ctx.profile.full_name} businessName={env.businessName}>
      {children}
    </AppShell>
  );
}

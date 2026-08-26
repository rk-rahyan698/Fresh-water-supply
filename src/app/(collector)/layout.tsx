import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { env } from "@/lib/env";

/**
 * Collector routes live under /my/* so they never collide with the admin
 * routes of the same name.
 *
 * Admins are sent to their own dashboard: they collect payments from the admin
 * client page, and their figures show up in the Collector Report like anyone
 * else's.
 */
export default async function CollectorLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireUser();
  if (ctx.profile.role === "admin") redirect("/dashboard");

  return (
    <AppShell role="collector" userName={ctx.profile.full_name} businessName={env.businessName}>
      {children}
    </AppShell>
  );
}

import { redirect } from "next/navigation";
import { getSessionContext, homePathForRole } from "@/lib/auth";

/** `/` is just a signpost: it sends each role to the right dashboard. */
export default async function RootPage() {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  if (!ctx.profile.is_active) redirect("/login?error=inactive");
  redirect(homePathForRole(ctx.profile.role));
}

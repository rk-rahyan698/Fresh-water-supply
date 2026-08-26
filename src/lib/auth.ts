import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

export interface SessionContext {
  userId: string;
  email: string | null;
  profile: Profile;
}

/**
 * Resolves the signed-in user and their profile.
 *
 * Wrapped in React's `cache` so a layout and the page beneath it share one
 * lookup per request instead of hitting Supabase twice.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createClient();

  // getUser() revalidates the JWT with Supabase. getSession() would just trust
  // the cookie, which is not good enough for an authorisation decision.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) return null;

  return { userId: user.id, email: user.email ?? null, profile };
});

/** Any signed-in, active user. Redirects to /login otherwise. */
export async function requireUser(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  if (!ctx.profile.is_active) redirect("/login?error=inactive");
  return ctx;
}

/** Admins only. Collectors are sent to their own dashboard. */
export async function requireAdmin(): Promise<SessionContext> {
  const ctx = await requireUser();
  if (ctx.profile.role !== "admin") redirect("/my/dashboard");
  return ctx;
}

/** The landing route for a role, used after login and from `/`. */
export function homePathForRole(role: Profile["role"]): string {
  return role === "admin" ? "/dashboard" : "/my/dashboard";
}

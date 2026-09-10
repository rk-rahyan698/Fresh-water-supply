"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { actionError, type ActionResult } from "@/lib/errors";
import { loginSchema } from "@/lib/validations/user";
import { fieldErrorsFrom } from "@/lib/validations/shared";
import { homePathForRole } from "@/lib/auth";

type State = ActionResult<null> | null;

/**
 * The only redirect target we will ever accept: a path on this origin.
 *
 * `startsWith("/") && !startsWith("//")` is not enough. Browsers normalise
 * backslashes to forward slashes when parsing a URL, so a crafted
 * `?next=/\evil.com` survives that check and reaches the browser as
 * `//evil.com` - a protocol-relative URL - which turns the login form into an
 * open redirect for anyone who can get that link in front of a user.
 *
 * Resolving against a throwaway origin settles it: anything that escapes that
 * origin - `//host`, `/\host`, an embedded scheme - lands somewhere else and is
 * refused. The path and query are rebuilt from the parse, so only a normalised
 * same-origin path is ever handed to redirect().
 */
function safeNextPath(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  try {
    const url = new URL(value, "http://localhost");
    if (url.origin !== "http://localhost") return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export async function signInAction(_prev: State, formData: FormData): Promise<State> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) return actionError(error);

  // The account exists in auth but has been switched off in the app.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile) {
    await supabase.auth.signOut();
    return actionError("Your account is not set up yet. Please contact the owner.");
  }

  if (!profile.is_active) {
    await supabase.auth.signOut();
    return actionError("Your account has been deactivated. Please contact the owner.");
  }

  const target = safeNextPath(formData.get("next")) ?? homePathForRole(profile.role);

  revalidatePath("/", "layout");
  // redirect() throws NEXT_REDIRECT - it must stay outside any try/catch.
  redirect(target);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

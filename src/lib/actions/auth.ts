"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { actionError, type ActionResult } from "@/lib/errors";
import { loginSchema } from "@/lib/validations/user";
import { fieldErrorsFrom } from "@/lib/validations/shared";
import { homePathForRole } from "@/lib/auth";

type State = ActionResult<null> | null;

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

  const next = formData.get("next");
  const target =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
      ? next
      : homePathForRole(profile.role);

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

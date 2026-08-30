"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { requireAdmin, requireUser, type SessionContext } from "@/lib/auth";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import {
  createUserSchema,
  deleteUserSchema,
  ownProfileSchema,
  resetPasswordSchema,
  updateUserSchema,
} from "@/lib/validations/user";
import { fieldErrorsFrom } from "@/lib/validations/shared";

/**
 * Re-checks the signed-in admin's own password.
 *
 * Creating and deleting accounts are the two actions that change who can get
 * into the system, so they ask the admin to prove it is really them - an
 * unattended laptop with a live session is not enough. The check is a real
 * sign-in on a throwaway client that persists nothing, so the admin's actual
 * session is untouched.
 *
 * Returns an error message, or null when the password is correct.
 */
async function confirmOwnPassword(ctx: SessionContext, password: string): Promise<string | null> {
  if (!ctx.email) return "Your account has no email address, so your password cannot be confirmed.";

  const probe = createSupabaseClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await probe.auth.signInWithPassword({ email: ctx.email, password });

  // scope: "local" is essential. The default is "global", which revokes every
  // refresh token the user holds - including the admin's own browser session,
  // logging them out every time they add or delete someone. Local only clears
  // this throwaway client, which persists nothing anyway.
  await probe.auth.signOut({ scope: "local" });

  if (!error) return null;
  return /invalid login credentials/i.test(error.message)
    ? "That is not your password. Please try again."
    : error.message;
}

type CreateState = ActionResult<{ id: string }> | null;

/**
 * Creating an auth user needs the service-role key, which is why this is the
 * one place `createAdminClient()` is used. requireAdmin() runs first, and the
 * key never leaves the server.
 */
export async function createUserAction(_prev: CreateState, formData: FormData): Promise<CreateState> {
  const ctx = await requireAdmin();

  const parsed = createUserSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    full_name: formData.get("full_name"),
    phone: formData.get("phone") ?? "",
    role: formData.get("role") ?? "collector",
    admin_password: formData.get("admin_password"),
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const values = parsed.data;

  // Confirm it is really the admin before handing out a new login.
  const wrongPassword = await confirmOwnPassword(ctx, values.admin_password);
  if (wrongPassword) return actionError(wrongPassword, { admin_password: wrongPassword });

  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email: values.email,
    password: values.password,
    email_confirm: true, // no inbox round-trip; the owner hands over the password
    user_metadata: {
      full_name: values.full_name,
      phone: values.phone ?? null,
      role: values.role,
    },
  });

  if (error) return actionError(error);
  if (!data.user) return actionError("Could not create the user. Please try again.");

  // The on_auth_user_created trigger has already inserted the profile from the
  // metadata above; this makes the role explicit in case metadata was ignored.
  const { error: profileError } = await admin
    .from("profiles")
    .update({
      full_name: values.full_name,
      phone: values.phone ?? null,
      role: values.role,
      email: values.email,
      is_active: true,
    })
    .eq("id", data.user.id);

  if (profileError) return actionError(profileError);

  revalidatePath("/users");
  return actionOk({ id: data.user.id });
}

type UpdateState = ActionResult<null> | null;

export async function updateUserAction(_prev: UpdateState, formData: FormData): Promise<UpdateState> {
  await requireAdmin();

  const parsed = updateUserSchema.safeParse({
    user_id: formData.get("user_id"),
    full_name: formData.get("full_name"),
    phone: formData.get("phone") ?? "",
    role: formData.get("role"),
    is_active: formData.get("is_active") === "true" || formData.get("is_active") === "on",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_profile", {
    p_user_id: parsed.data.user_id,
    p_full_name: parsed.data.full_name,
    p_phone: parsed.data.phone ?? null,
    p_role: parsed.data.role,
    p_is_active: parsed.data.is_active,
  });

  if (error) return actionError(error);

  revalidatePath("/users");
  revalidatePath("/", "layout");
  return actionOk(null);
}

export async function resetUserPasswordAction(
  _prev: UpdateState,
  formData: FormData,
): Promise<UpdateState> {
  await requireAdmin();

  const parsed = resetPasswordSchema.safeParse({
    user_id: formData.get("user_id"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(parsed.data.user_id, {
    password: parsed.data.password,
  });

  if (error) return actionError(error);

  revalidatePath("/users");
  return actionOk(null);
}

export async function updateOwnProfileAction(
  _prev: UpdateState,
  formData: FormData,
): Promise<UpdateState> {
  await requireUser();

  const parsed = ownProfileSchema.safeParse({
    full_name: formData.get("full_name"),
    phone: formData.get("phone") ?? "",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_own_profile", {
    p_full_name: parsed.data.full_name,
    p_phone: parsed.data.phone ?? null,
  });

  if (error) return actionError(error);

  revalidatePath("/my/profile");
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return actionOk(null);
}

/* -------------------------------------------------------------------------- */
/* Deleting a user                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every foreign key that points at profiles and is ON DELETE RESTRICT.
 *
 * Deleting an auth user cascades to its profile row, which then collides with
 * these. Checking first turns a raw constraint error into a sentence that says
 * which history is in the way.
 *
 * Written as typed closures rather than {table, column} strings so the column
 * names stay checked against the schema.
 */
function restrictingReferences(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const tally = async (p: PromiseLike<{ count: number | null }>) => (await p).count ?? 0;
  return [
    {
      label: "payments they collected",
      count: () => tally(admin.from("payments").select("*", { count: "exact", head: true }).eq("collected_by", userId)),
    },
    {
      label: "payments they voided",
      count: () => tally(admin.from("payments").select("*", { count: "exact", head: true }).eq("voided_by", userId)),
    },
    {
      label: "cash submissions they made",
      count: () => tally(admin.from("cash_submissions").select("*", { count: "exact", head: true }).eq("collector_id", userId)),
    },
    {
      label: "cash submissions they received",
      count: () => tally(admin.from("cash_submissions").select("*", { count: "exact", head: true }).eq("received_by", userId)),
    },
    {
      label: "bill adjustments they approved",
      count: () => tally(admin.from("monthly_bills").select("*", { count: "exact", head: true }).eq("adjusted_by", userId)),
    },
    {
      label: "rate changes they made",
      count: () => tally(admin.from("client_rate_history").select("*", { count: "exact", head: true }).eq("changed_by", userId)),
    },
  ];
}

/**
 * Permanently deletes a user, after the acting admin re-enters their own
 * password.
 *
 * Deletion is only possible for an account with no financial history. Anyone
 * who has touched money is protected by ON DELETE RESTRICT, and the right
 * answer for them is deactivation - their name has to keep appearing on the
 * payments they collected.
 */
export async function deleteUserAction(
  _prev: UpdateState,
  formData: FormData,
): Promise<UpdateState> {
  const ctx = await requireAdmin();

  const parsed = deleteUserSchema.safeParse({
    user_id: formData.get("user_id"),
    admin_password: formData.get("admin_password"),
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const { user_id: userId, admin_password: adminPassword } = parsed.data;

  if (userId === ctx.userId) {
    return actionError("You cannot delete your own account.");
  }

  const admin = createAdminClient();

  const { data: target, error: loadError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (loadError) return actionError(loadError);
  if (!target) return actionError("User not found.");

  // Never remove the last way into the system.
  if (target.role === "admin" && target.is_active) {
    const { count } = await admin
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_active", true);
    if ((count ?? 0) <= 1) {
      return actionError("This is the last active admin. Promote someone else first.");
    }
  }

  // Financial history blocks deletion - say which, rather than leaking a
  // foreign key violation.
  for (const ref of restrictingReferences(admin, userId)) {
    const found = await ref.count();
    if (found > 0) {
      return actionError(
        `${target.full_name} has ${found} ${ref.label} on record and cannot be deleted - ` +
          `that history has to keep their name on it. Set the account to Inactive instead.`,
      );
    }
  }

  // Checked last, so the cheaper guards above explain themselves without the
  // admin having typed a password for a delete that was never going to happen.
  const wrongPassword = await confirmOwnPassword(ctx, adminPassword);
  if (wrongPassword) return actionError(wrongPassword, { admin_password: wrongPassword });

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) return actionError(deleteError);

  // Written after the fact, so a failed delete never leaves a false record.
  // write_audit() is not callable by `authenticated`, so this goes in through
  // the service-role client, which bypasses RLS.
  await admin.from("audit_logs").insert({
    user_id: ctx.userId,
    action: "user.deleted",
    entity_type: "profile",
    entity_id: userId,
    old_data: target,
    new_data: null,
  } as never);

  revalidatePath("/users");
  revalidatePath("/", "layout");
  return actionOk(null);
}

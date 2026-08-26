"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireUser } from "@/lib/auth";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import {
  createUserSchema,
  ownProfileSchema,
  resetPasswordSchema,
  updateUserSchema,
} from "@/lib/validations/user";
import { fieldErrorsFrom } from "@/lib/validations/shared";

type CreateState = ActionResult<{ id: string }> | null;

/**
 * Creating an auth user needs the service-role key, which is why this is the
 * one place `createAdminClient()` is used. requireAdmin() runs first, and the
 * key never leaves the server.
 */
export async function createUserAction(_prev: CreateState, formData: FormData): Promise<CreateState> {
  await requireAdmin();

  const parsed = createUserSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    full_name: formData.get("full_name"),
    phone: formData.get("phone") ?? "",
    role: formData.get("role") ?? "collector",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const values = parsed.data;
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

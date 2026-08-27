"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import { areaSchema, clientAreaSchema, clientRateSchema } from "@/lib/validations/area";
import { fieldErrorsFrom } from "@/lib/validations/shared";
import type { Area, Client } from "@/types/database";

/**
 * Areas, client area assignment, and scheduled rate changes.
 *
 * All admin-only. Each SQL function re-checks the role from the JWT, so these
 * guards are convenience rather than the boundary.
 */

function revalidateAreas(clientId?: string) {
  revalidatePath("/areas");
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  revalidatePath("/bills");
  revalidatePath("/reports/area");
  revalidatePath("/reports/due");
  revalidatePath("/reports/monthly");
  revalidatePath("/my/clients");
  if (clientId) {
    revalidatePath(`/clients/${clientId}`);
    revalidatePath(`/my/clients/${clientId}`);
  }
}

type AreaState = ActionResult<{ id: string }> | null;

export async function saveAreaAction(_prev: AreaState, formData: FormData): Promise<AreaState> {
  await requireAdmin();

  const parsed = areaSchema.safeParse({
    id: (formData.get("id") as string) || undefined,
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    is_active: formData.get("is_active") !== "false",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("upsert_area", {
    p_id: parsed.data.id ?? null,
    p_name: parsed.data.name,
    p_description: parsed.data.description ?? null,
    p_is_active: parsed.data.is_active,
  });

  if (error) return actionError(error);

  revalidateAreas();
  return actionOk({ id: (data as unknown as Area).id });
}

export async function deleteAreaAction(areaId: string): Promise<ActionResult<null>> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_area", { p_area_id: areaId });
  if (error) return actionError(error);

  revalidateAreas();
  return actionOk(null);
}

/**
 * Reassigning an area changes where the client is counted from now on.
 * Bills and payments are never rewritten (spec section 27).
 */
export async function setClientAreaAction(
  clientId: string,
  areaId: string | null,
): Promise<ActionResult<null>> {
  await requireAdmin();

  const parsed = clientAreaSchema.safeParse({ client_id: clientId, area_id: areaId ?? null });
  if (!parsed.success) return actionError("Select a valid area.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_client_area", {
    p_client_id: parsed.data.client_id,
    p_area_id: parsed.data.area_id ?? null,
  });

  if (error) return actionError(error);

  revalidateAreas(clientId);
  return actionOk(null);
}

type RateState = ActionResult<{ effectiveFrom: string; amount: number }> | null;

/**
 * Schedules a new monthly rate from a given month onwards.
 *
 * Months that are already billed keep their snapshot - bill generation copies
 * the rate into the bill row, and an existing bill is never rewritten.
 */
export async function setClientRateAction(_prev: RateState, formData: FormData): Promise<RateState> {
  await requireAdmin();

  const parsed = clientRateSchema.safeParse({
    client_id: formData.get("client_id"),
    monthly_bill: formData.get("monthly_bill"),
    effective_from: formData.get("effective_from"),
    reason: formData.get("reason") ?? "",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_client_rate", {
    p_client_id: parsed.data.client_id,
    p_monthly_bill: parsed.data.monthly_bill,
    p_effective_from: parsed.data.effective_from,
    p_reason: parsed.data.reason ?? null,
  });

  if (error) return actionError(error);

  revalidateAreas(parsed.data.client_id);
  return actionOk({
    effectiveFrom: parsed.data.effective_from,
    amount: parsed.data.monthly_bill,
  });
}

/** Used by the client form's area dropdown on the server side. */
export async function listAreasForForm(): Promise<Pick<Area, "id" | "name">[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("areas")
    .select("id, name")
    .eq("is_active", true)
    .order("name");
  return data ?? [];
}

export type { Client };

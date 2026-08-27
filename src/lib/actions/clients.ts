"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import { clientSchema } from "@/lib/validations/client";
import { fieldErrorsFrom } from "@/lib/validations/shared";
import type { Client, ClientStatus } from "@/types/database";

type State = ActionResult<{ id: string }> | null;

function revalidateClients(id?: string) {
  revalidatePath("/clients");
  revalidatePath("/areas");
  revalidatePath("/reports/area");
  revalidatePath("/dashboard");
  revalidatePath("/my/clients");
  if (id) {
    revalidatePath(`/clients/${id}`);
    revalidatePath(`/my/clients/${id}`);
  }
}

export async function saveClientAction(_prev: State, formData: FormData): Promise<State> {
  await requireAdmin();

  const raw = {
    id: (formData.get("id") as string) || undefined,
    client_code: formData.get("client_code"),
    name: formData.get("name"),
    phone: formData.get("phone") ?? "",
    address: formData.get("address") ?? "",
    monthly_bill: formData.get("monthly_bill"),
    area_id: (formData.get("area_id") as string) || null,
    start_date: formData.get("start_date"),
    status: formData.get("status") ?? "active",
    notes: formData.get("notes") ?? "",
  };

  const parsed = clientSchema.safeParse(raw);
  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const values = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("upsert_client", {
    p_id: values.id ?? null,
    p_client_code: values.client_code,
    p_name: values.name,
    p_phone: values.phone ?? null,
    p_address: values.address ?? null,
    p_monthly_bill: values.monthly_bill,
    p_start_date: values.start_date,
    p_status: values.status,
    p_notes: values.notes ?? null,
    p_area_id: values.area_id ?? null,
  });

  if (error) return actionError(error);

  const saved = data as unknown as Client;
  revalidateClients(saved.id);
  return actionOk({ id: saved.id });
}

export async function setClientStatusAction(
  clientId: string,
  status: ClientStatus,
): Promise<ActionResult<null>> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_client_status", {
    p_client_id: clientId,
    p_status: status,
  });

  if (error) return actionError(error);

  revalidateClients(clientId);
  revalidatePath("/bills");
  return actionOk(null);
}

/**
 * Hard delete. The SQL function refuses if the client has any payment history,
 * so this can only ever remove a client created by mistake.
 */
export async function deleteClientAction(clientId: string): Promise<ActionResult<null>> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_client", { p_client_id: clientId });

  if (error) return actionError(error);

  revalidateClients(clientId);
  return actionOk(null);
}

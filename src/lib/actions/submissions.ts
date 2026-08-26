"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { actionError, actionOk, type ActionResult } from "@/lib/errors";
import { submissionSchema } from "@/lib/validations/submission";
import { fieldErrorsFrom } from "@/lib/validations/shared";
import type { CashSubmission } from "@/types/database";

type State = ActionResult<{ id: string; amount: number }> | null;

/**
 * Only an admin records a submission: the owner is the one receiving the cash,
 * and `received_by` is stamped from their own session inside the SQL function.
 */
export async function createSubmissionAction(_prev: State, formData: FormData): Promise<State> {
  await requireAdmin();

  const parsed = submissionSchema.safeParse({
    collector_id: formData.get("collector_id"),
    amount: formData.get("amount"),
    submission_date: (formData.get("submission_date") as string) || undefined,
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) {
    return actionError("Please check the form.", fieldErrorsFrom(parsed.error));
  }

  const values = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("create_cash_submission", {
    p_collector_id: values.collector_id,
    p_amount: values.amount,
    p_submission_date: values.submission_date ?? null,
    p_notes: values.notes ?? null,
  });

  if (error) return actionError(error);

  const submission = data as unknown as CashSubmission;

  revalidatePath("/submissions");
  revalidatePath("/dashboard");
  revalidatePath("/reports/collector");
  revalidatePath("/my/dashboard");
  revalidatePath("/my/submissions");

  return actionOk({ id: submission.id, amount: Number(submission.amount) });
}

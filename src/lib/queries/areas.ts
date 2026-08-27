import "server-only";

import { createClient } from "@/lib/supabase/server";
import { dhakaCurrentMonth } from "@/lib/format";
import type { Area } from "@/types/database";

/** All areas, active first. Used by every area filter and the areas screen. */
export async function listAreas(includeInactive = true): Promise<Area[]> {
  const supabase = await createClient();
  let query = supabase.from("areas").select("*").order("name", { ascending: true });
  if (!includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getArea(id: string): Promise<Area | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("areas").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/** How many clients sit in each area - shown on the areas screen. */
export async function getAreaClientCounts(): Promise<Map<string, number>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").select("area_id");
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    if (!row.area_id) continue;
    counts.set(row.area_id, (counts.get(row.area_id) ?? 0) + 1);
  }
  return counts;
}

export interface AreaSummaryRow {
  areaId: string | null;
  areaName: string;
  isActive: boolean;
  clientCount: number;
  originalAmount: number;
  adjustmentAmount: number;
  adjustedAmount: number;
  collectedAmount: number;
  dueAmount: number;
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
}

/**
 * Area-wise financials for one month (spec sections 21, 32).
 *
 * Clients without an area come back as an "Unassigned" row rather than being
 * dropped, so the area totals always add up to the business totals.
 */
export async function getAreaSummary(month?: string): Promise<AreaSummaryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("area_summary", {
    p_month: month ?? dhakaCurrentMonth(),
  });
  if (error) throw error;

  return (data ?? [])
    .map((row) => ({
      areaId: row.area_id,
      areaName: row.area_name,
      isActive: row.is_active,
      clientCount: Number(row.client_count),
      originalAmount: Number(row.original_amount),
      adjustmentAmount: Number(row.adjustment_amount),
      adjustedAmount: Number(row.adjusted_amount),
      collectedAmount: Number(row.collected_amount),
      dueAmount: Number(row.due_amount),
      paidCount: Number(row.paid_count),
      partialCount: Number(row.partial_count),
      unpaidCount: Number(row.unpaid_count),
    }))
    .sort((a, b) => b.adjustedAmount - a.adjustedAmount || a.areaName.localeCompare(b.areaName));
}

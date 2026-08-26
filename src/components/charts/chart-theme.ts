import { CURRENCY_SYMBOL } from "@/lib/format";

/**
 * Chart colours.
 *
 * Slots 1 and 2 of the reference categorical palette. Validated against a white
 * chart surface: CVD separation dE 24.7 (protan), normal-vision dE 33.6,
 * both above the >=8 / >=15 gates, and both clear 3:1 contrast.
 *
 * Colour follows the meaning, never the rank - "collected" stays blue whether
 * it is the biggest slice or the smallest.
 */
export const SERIES = {
  collected: "#2a78d6", // categorical slot 1 - blue
  due: "#eb6834", // categorical slot 2 - orange
} as const;

/** Chrome recedes: hairline grid one shade off the surface, muted tick text. */
export const CHART_CHROME = {
  grid: "#e6e6ea",
  tick: "#6b7280",
  surface: "#ffffff",
} as const;

/** Axis ticks: `150000` -> `"৳150k"`. Full precision lives in the tooltip. */
export function compactCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${CURRENCY_SYMBOL}${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${CURRENCY_SYMBOL}${Math.round(value / 1_000)}k`;
  return `${CURRENCY_SYMBOL}${value}`;
}

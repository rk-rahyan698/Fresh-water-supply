import { en, type Dictionary } from "./en";

export type Locale = "en" | "bn";

/**
 * Active locale. English only for now.
 *
 * To add Bengali: create `bn.ts` exporting the same shape as `en.ts`, add it to
 * `dictionaries` below, and switch `ACTIVE_LOCALE` (or read it from a user
 * setting). Because every component imports `t` from here rather than
 * hardcoding strings, nothing else has to change.
 */
export const ACTIVE_LOCALE: Locale = "en";

const dictionaries: Record<Locale, Dictionary> = {
  en,
  bn: en, // placeholder until bn.ts exists
};

export const t: Dictionary = dictionaries[ACTIVE_LOCALE];

export type { Dictionary };

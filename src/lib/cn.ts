type ClassValue = string | number | false | null | undefined;

/** Tiny class-name joiner - avoids pulling in clsx for a six-line helper. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}

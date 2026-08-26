"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";
import { t } from "@/lib/i18n";

/** Builds the next URL, dropping empty values and resetting pagination. */
function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (updates: Record<string, string | undefined>, { replace = false } = {}) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "") params.delete(key);
      else params.set(key, value);
    }
    // Any filter change invalidates the current page number.
    if (!("page" in updates)) params.delete("page");

    const query = params.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    if (replace) router.replace(url);
    else router.push(url);
  };
}

/* -------------------------------------------------------------------------- */

const CONTROL =
  "h-11 rounded-xl border border-line bg-white px-3 text-sm text-ink " +
  "focus:outline-2 focus:outline-offset-0 focus:outline-brand-500";

export function UrlSelect({
  param,
  value,
  options,
  label,
  className,
  ariaLabel,
}: {
  param: string;
  value: string;
  options: { value: string; label: string }[];
  label?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const write = useParamWriter();
  const [pending, startTransition] = useTransition();

  return (
    <label className={cn("relative flex min-w-0 flex-col gap-1", className)}>
      {label && <span className="text-xs font-medium text-ink-soft">{label}</span>}
      <select
        aria-label={ariaLabel ?? label ?? param}
        value={value}
        disabled={pending}
        onChange={(event) => startTransition(() => write({ [param]: event.target.value }))}
        className={cn(CONTROL, "appearance-none pr-8", pending && "opacity-60")}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%23667' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 0.6rem center",
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function UrlDateInput({
  param,
  value,
  label,
  className,
  max,
}: {
  param: string;
  value: string;
  label?: string;
  className?: string;
  max?: string;
}) {
  const write = useParamWriter();
  const [pending, startTransition] = useTransition();

  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      {label && <span className="text-xs font-medium text-ink-soft">{label}</span>}
      <input
        type="date"
        value={value}
        max={max}
        disabled={pending}
        onChange={(event) => startTransition(() => write({ [param]: event.target.value }))}
        className={cn(CONTROL, pending && "opacity-60")}
      />
    </label>
  );
}

/**
 * Search box that writes to the URL after a short pause.
 *
 * Debounced so a collector typing a name on a phone does not fire a query per
 * keystroke, and `replace` keeps the back button usable.
 */
export function UrlSearchInput({
  param = "q",
  initialValue,
  placeholder,
  className,
  autoFocus,
}: {
  param?: string;
  initialValue: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const write = useParamWriter();
  const [value, setValue] = useState(initialValue);
  const [syncedValue, setSyncedValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const isFirstRender = useRef(true);

  // Re-sync when the URL changes from elsewhere (a Clear button, the back
  // button). Adjusting state during render rather than in an effect - React's
  // documented pattern - avoids the extra render pass an effect would cost.
  if (initialValue !== syncedValue) {
    setSyncedValue(initialValue);
    setValue(initialValue);
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (value === initialValue) return;

    const timeout = window.setTimeout(() => {
      startTransition(() => write({ [param]: value || undefined }, { replace: true }));
    }, 300);
    return () => window.clearTimeout(timeout);
    // `write` is recreated per render; depending on it would reset the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, initialValue, param]);

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder ?? t.common.search}
        aria-label={placeholder ?? t.common.search}
        className="h-11 w-full rounded-xl border border-line bg-white pr-10 pl-10 text-sm text-ink placeholder:text-ink-faint focus:outline-2 focus:outline-offset-0 focus:outline-brand-500"
      />
      <span className="absolute top-1/2 right-3 -translate-y-1/2">
        {pending ? (
          <Spinner className="size-4 text-ink-faint" />
        ) : value ? (
          <button
            type="button"
            onClick={() => setValue("")}
            aria-label={t.common.clear}
            className="block rounded-full p-0.5 text-ink-faint hover:text-ink"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** One filter row above the content it scopes. */
export function FilterBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-end gap-2.5 rounded-2xl border border-line bg-surface px-3 py-3 shadow-sm sm:px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

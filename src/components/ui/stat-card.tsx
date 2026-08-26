import Link from "next/link";
import { cn } from "@/lib/cn";

type Tone = "default" | "positive" | "warning" | "danger" | "brand";

const TONE_VALUE: Record<Tone, string> = {
  default: "text-ink",
  positive: "text-positive",
  warning: "text-warning",
  danger: "text-danger",
  brand: "text-brand-600",
};

const TONE_ICON: Record<Tone, string> = {
  default: "bg-black/5 text-ink-soft",
  positive: "bg-positive-soft text-positive",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  brand: "bg-brand-50 text-brand-600",
};

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  icon?: React.ComponentType<{ className?: string }>;
  href?: string;
  className?: string;
}

/**
 * The dashboard's headline numbers. Value uses tabular figures so a column of
 * cards does not jitter as amounts change.
 */
export function StatCard({
  label,
  value,
  sub,
  tone = "default",
  icon: Icon,
  href,
  className,
}: StatCardProps) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-ink-soft">{label}</p>
        {Icon && (
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE_ICON[tone])}>
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <p className={cn("tnum mt-2 text-2xl font-semibold tracking-tight", TONE_VALUE[tone])}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
    </>
  );

  const base = cn(
    "block rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-sm",
    href && "transition-colors hover:border-brand-200 hover:bg-brand-50/40",
    className,
  );

  return href ? (
    <Link href={href} className={base}>
      {content}
    </Link>
  ) : (
    <div className={base}>{content}</div>
  );
}

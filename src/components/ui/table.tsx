import { cn } from "@/lib/cn";

/**
 * Tables scroll inside their own container so a wide report never makes the
 * whole page scroll sideways on a phone.
 *
 * Most list screens show `<MobileCard>` stacks below `sm` and the table above
 * it - see the collections and due-report pages.
 */
export function TableWrap({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("w-full overflow-x-auto", className)}>{children}</div>;
}

export function Table({ className, children }: { className?: string; children: React.ReactNode }) {
  return <table className={cn("w-full min-w-full border-collapse text-sm", className)}>{children}</table>;
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="bg-canvas/70">{children}</thead>;
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <tr className={cn("transition-colors hover:bg-canvas/60", className)}>{children}</tr>;
}

export function TH({
  className,
  align = "left",
  children,
}: {
  className?: string;
  align?: "left" | "right" | "center";
  children?: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-line px-3 py-2.5 text-xs font-semibold tracking-wide text-ink-soft uppercase",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  className,
  align = "left",
  numeric,
  children,
}: {
  className?: string;
  align?: "left" | "right" | "center";
  numeric?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <td
      className={cn(
        "px-3 py-3 text-ink align-middle",
        numeric && "tnum",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Totals row pinned to the bottom of a report table. */
export function TFootRow({ children }: { children: React.ReactNode }) {
  return (
    <tfoot>
      <tr className="border-t-2 border-line bg-canvas font-semibold text-ink">{children}</tr>
    </tfoot>
  );
}

/** One record rendered as a card - the mobile counterpart of a table row. */
export function MobileCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("border-b border-line px-4 py-3.5 last:border-b-0", className)}>{children}</div>
  );
}

/** Label/value pair inside a MobileCard. */
export function MobileField({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 text-sm", className)}>
      <span className="text-ink-soft">{label}</span>
      <span className="tnum font-medium text-ink">{value}</span>
    </div>
  );
}

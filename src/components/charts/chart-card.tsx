"use client";

import { useState } from "react";
import { BarChart3, Table2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/card";

/**
 * Chart card with a built-in table view.
 *
 * Every chart needs a WCAG-clean twin: the numbers must be reachable without
 * relying on colour or on hovering a bar. The toggle is that twin.
 */
export function ChartCard({
  title,
  description,
  chart,
  table,
  className,
}: {
  title: string;
  description?: string;
  chart: React.ReactNode;
  table: React.ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");

  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-soft">{description}</p>}
        </div>
        <div
          role="group"
          aria-label="Change view"
          className="flex shrink-0 rounded-lg border border-line p-0.5"
        >
          <ViewButton
            active={view === "chart"}
            onClick={() => setView("chart")}
            label="Chart view"
            icon={BarChart3}
          />
          <ViewButton
            active={view === "table"}
            onClick={() => setView("table")}
            label="Table view"
            icon={Table2}
          />
        </div>
      </div>
      <div className="px-2 py-4 sm:px-4">{view === "chart" ? chart : table}</div>
    </Card>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "rounded-md p-1.5 transition-colors",
        active ? "bg-brand-50 text-brand-700" : "text-ink-faint hover:text-ink",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/** Legend swatch + label. Identity is never carried by colour alone. */
export function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <ul className="mb-1 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
          <span
            aria-hidden
            className="size-2.5 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

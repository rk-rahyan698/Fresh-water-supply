"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard, ChartLegend } from "./chart-card";
import { CHART_CHROME, SERIES, compactCurrency } from "./chart-theme";
import { formatCurrency, formatMonthShort } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { t } from "@/lib/i18n";
import type { MonthlySeriesPoint } from "@/lib/queries/reports";

interface Row {
  month: string;
  label: string;
  billed: number;
  collected: number;
  due: number;
}

/**
 * Collected and due are stacked because they sum to exactly the billed amount -
 * the total bar height *is* the month's bill. Showing billed as a third bar
 * would plot the same number twice.
 */
export function MonthlyCollectionChart({ data }: { data: MonthlySeriesPoint[] }) {
  const rows: Row[] = data.map((point) => ({
    month: point.billing_month,
    label: formatMonthShort(point.billing_month),
    billed: point.billed_amount,
    collected: point.collected_amount,
    due: point.due_amount,
  }));

  const hasData = rows.some((row) => row.billed > 0);

  return (
    <ChartCard
      title={t.dashboard.monthlyChart}
      description="Each bar is the month's total bill, split into what has been collected and what is still due."
      chart={
        hasData ? (
          <div>
            <ChartLegend
              items={[
                { color: SERIES.collected, label: t.dashboard.monthCollected },
                { color: SERIES.due, label: t.dashboard.monthDue },
              ]}
            />
            {/* Height includes the x-axis band so the card never scrolls. */}
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid
                    vertical={false}
                    stroke={CHART_CHROME.grid}
                    strokeWidth={1}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={{ stroke: CHART_CHROME.grid }}
                    tick={{ fill: CHART_CHROME.tick, fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={compactCurrency}
                    tickLine={false}
                    axisLine={false}
                    width={58}
                    tick={{ fill: CHART_CHROME.tick, fontSize: 12 }}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(0,0,0,0.04)" }}
                    content={<MonthlyTooltip />}
                  />
                  <Bar
                    dataKey="collected"
                    name={t.dashboard.monthCollected}
                    stackId="bill"
                    fill={SERIES.collected}
                    maxBarSize={44}
                    // Rounds the top only when this is the topmost visible segment.
                    shape={<StackSegment position="bottom" />}
                  />
                  <Bar
                    dataKey="due"
                    name={t.dashboard.monthDue}
                    stackId="bill"
                    fill={SERIES.due}
                    maxBarSize={44}
                    shape={<StackSegment position="top" />}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <EmptyState title={t.dashboard.noData} description="Generate monthly bills to see this chart." />
        )
      }
      table={<MonthlyTable rows={rows} />}
    />
  );
}

interface SegmentProps {
  position?: "top" | "bottom";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: Row;
}

/**
 * Stacked segment with a 4px rounded data-end and a 2px surface gap between the
 * two fills - a gap, not a contrasting border.
 */
function StackSegment(props: SegmentProps) {
  const { position, payload, height = 0, y = 0, ...rest } = props;
  if (height <= 0) return null;

  const isTopMost = position === "top" || (payload ? payload.due <= 0 : false);
  const radius: [number, number, number, number] = isTopMost ? [4, 4, 0, 0] : [0, 0, 0, 0];

  // SVG y is the top edge, so the gap has to come off the *upper* segment's
  // underside: push its top down 2px and shorten it by the same amount. Doing
  // it to the lower segment would open a gap at the baseline instead.
  const needsGap = position === "top" && height > 3 && (payload?.collected ?? 0) > 0;

  return (
    <Rectangle
      {...rest}
      y={needsGap ? y + 2 : y}
      height={needsGap ? height - 2 : height}
      radius={radius}
    />
  );
}

interface TooltipPayloadItem {
  payload: Row;
}

function MonthlyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5 shadow-lg">
      <p className="mb-1.5 text-xs font-semibold text-ink">{formatMonthShort(row.month)}</p>
      <dl className="space-y-1 text-xs">
        <TooltipRow label={t.report.totalBilled} value={formatCurrency(row.billed)} />
        <TooltipRow
          label={t.dashboard.monthCollected}
          value={formatCurrency(row.collected)}
          color={SERIES.collected}
        />
        <TooltipRow label={t.dashboard.monthDue} value={formatCurrency(row.due)} color={SERIES.due} />
      </dl>
    </div>
  );
}

function TooltipRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="flex items-center gap-1.5 text-ink-soft">
        {color && <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color }} />}
        {label}
      </dt>
      <dd className="tnum font-semibold text-ink">{value}</dd>
    </div>
  );
}

function MonthlyTable({ rows }: { rows: Row[] }) {
  return (
    <TableWrap>
      <Table>
        <THead>
          <TR>
            <TH>{t.common.month}</TH>
            <TH align="right">{t.report.totalBilled}</TH>
            <TH align="right">{t.report.totalCollected}</TH>
            <TH align="right">{t.report.totalDue}</TH>
          </TR>
        </THead>
        <TBody>
          {[...rows].reverse().map((row) => (
            <TR key={row.month}>
              <TD>{formatMonthShort(row.month)}</TD>
              <TD align="right" numeric>
                {formatCurrency(row.billed)}
              </TD>
              <TD align="right" numeric>
                {formatCurrency(row.collected)}
              </TD>
              <TD align="right" numeric className={row.due > 0 ? "text-danger" : undefined}>
                {formatCurrency(row.due)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}

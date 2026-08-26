"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "./chart-card";
import { CHART_CHROME, SERIES, compactCurrency } from "./chart-theme";
import { formatCurrency } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableWrap, TBody, TD, TFootRow, TH, THead, TR } from "@/components/ui/table";
import { t } from "@/lib/i18n";
import type { CollectorSeriesPoint } from "@/lib/queries/reports";

/**
 * One series, so one colour for every bar - never a value ramp across nominal
 * categories, and no legend (the title names the series). Bars are horizontal
 * because collector names are text.
 */
export function CollectorCollectionChart({
  data,
  description,
}: {
  data: CollectorSeriesPoint[];
  description?: string;
}) {
  const rows = data.map((point) => ({
    id: point.collector_id,
    name: point.collector_name,
    total: point.total_amount,
    count: point.payments_count,
  }));

  const total = rows.reduce((sum, row) => sum + row.total, 0);
  // Roughly 44px per bar, plus room for the axis band.
  const chartHeight = Math.max(180, rows.length * 46 + 48);

  return (
    <ChartCard
      title={t.dashboard.collectorChart}
      description={description}
      chart={
        rows.length > 0 ? (
          <div style={{ height: chartHeight }} className="w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 4, right: 64, bottom: 4, left: 4 }}
              >
                <CartesianGrid horizontal={false} stroke={CHART_CHROME.grid} strokeWidth={1} />
                <XAxis
                  type="number"
                  tickFormatter={compactCurrency}
                  tickLine={false}
                  axisLine={{ stroke: CHART_CHROME.grid }}
                  tick={{ fill: CHART_CHROME.tick, fontSize: 12 }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  width={96}
                  tick={{ fill: CHART_CHROME.tick, fontSize: 12 }}
                />
                <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} content={<CollectorTooltip />} />
                <Bar dataKey="total" radius={[0, 4, 4, 0]} maxBarSize={28}>
                  {rows.map((row) => (
                    <Cell key={row.id} fill={SERIES.collected} />
                  ))}
                  {/* Few enough bars that every one can carry its value. */}
                  <LabelList
                    dataKey="total"
                    position="right"
                    formatter={(value: unknown) =>
                      typeof value === "number" ? formatCurrency(value) : ""
                    }
                    style={{ fill: "#374151", fontSize: 12, fontWeight: 600 }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState title={t.dashboard.noData} description="No payments were collected in this period." />
        )
      }
      table={
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>{t.submission.collector}</TH>
                <TH align="right">{t.report.collectionCount}</TH>
                <TH align="right">{t.report.totalCollected}</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>{row.name}</TD>
                  <TD align="right" numeric>
                    {row.count}
                  </TD>
                  <TD align="right" numeric>
                    {formatCurrency(row.total)}
                  </TD>
                </TR>
              ))}
            </TBody>
            {rows.length > 0 && (
              <TFootRow>
                <TD>{t.report.grandTotal}</TD>
                <TD align="right" numeric>
                  {rows.reduce((sum, row) => sum + row.count, 0)}
                </TD>
                <TD align="right" numeric>
                  {formatCurrency(total)}
                </TD>
              </TFootRow>
            )}
          </Table>
        </TableWrap>
      }
    />
  );
}

interface CollectorRow {
  name: string;
  total: number;
  count: number;
}

function CollectorTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: CollectorRow }[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5 shadow-lg">
      <p className="text-xs font-semibold text-ink">{row.name}</p>
      <p className="tnum mt-1 text-sm font-semibold text-ink">{formatCurrency(row.total)}</p>
      <p className="mt-0.5 text-xs text-ink-soft">
        {row.count} {t.dashboard.paymentsCount}
      </p>
    </div>
  );
}

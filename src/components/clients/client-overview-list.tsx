import Link from "next/link";
import { ChevronRight, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge, BillStatusBadge, ClientStatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatCurrency, formatMonth } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { ClientOverviewRow } from "@/lib/queries/clients";

/**
 * Client list with this month's bill attached (spec section 24), so the owner
 * can see who is paid, partial and unpaid without opening every profile.
 *
 * Clients with no bill for the month show "-" rather than a misleading ৳0.
 */
export function ClientOverviewList({
  rows,
  month,
  basePath,
  page,
  pageCount,
  total,
  searching,
  emptyAction,
}: {
  rows: ClientOverviewRow[];
  month: string;
  basePath: string;
  page: number;
  pageCount: number;
  total: number;
  searching: boolean;
  emptyAction?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title={searching ? t.client.emptySearch : t.client.empty}
          description={searching ? "Try a different name, phone, code or area." : undefined}
          action={emptyAction}
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* Mobile: one tappable row per client */}
      <ul className="divide-y divide-line sm:hidden">
        {rows.map((row) => (
          <li key={row.clientId}>
            <Link
              href={`${basePath}/${row.clientId}`}
              className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-canvas"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-ink">
                  {row.name}
                  {row.clientStatus === "inactive" && (
                    <ClientStatusBadge status={row.clientStatus} />
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-ink-soft">
                  {row.clientCode}
                  {row.areaName ? ` · ${row.areaName}` : ""}
                </p>
                <p className="mt-1 flex items-center gap-2 text-xs">
                  {row.billStatus ? (
                    <>
                      <BillStatusBadge status={row.billStatus} />
                      {Number(row.dueAmount) > 0 && (
                        <span className="tnum font-medium text-danger">
                          {t.bill.due} {formatCurrency(row.dueAmount)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">No bill this month</span>
                  )}
                </p>
              </div>
              <span className="tnum shrink-0 text-sm font-semibold text-ink">
                {formatCurrency(row.monthlyBill)}
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-faint" />
            </Link>
          </li>
        ))}
      </ul>

      {/* Desktop table */}
      <TableWrap className="hidden sm:block">
        <Table>
          <THead>
            <TR>
              <TH>{t.client.name}</TH>
              <TH>{t.area.one}</TH>
              <TH>{t.client.phone}</TH>
              <TH align="right">{t.bill.one}</TH>
              <TH align="right">{t.bill.paid}</TH>
              <TH align="right">{t.bill.due}</TH>
              <TH>{t.bill.status}</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.clientId}>
                <TD>
                  <Link
                    href={`${basePath}/${row.clientId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {row.name}
                  </Link>
                  <span className="block text-xs text-ink-faint">{row.clientCode}</span>
                </TD>
                <TD>
                  {row.areaName ? (
                    <Badge tone="neutral">{row.areaName}</Badge>
                  ) : (
                    <span className="text-xs text-ink-faint">{t.area.none}</span>
                  )}
                </TD>
                <TD className="text-ink-soft">
                  {row.phone ? (
                    <a href={`tel:${row.phone}`} className="hover:text-brand-600">
                      {row.phone}
                    </a>
                  ) : (
                    "-"
                  )}
                </TD>
                <TD align="right" numeric>
                  {row.adjustedAmount === null ? (
                    <span className="text-ink-faint">-</span>
                  ) : (
                    <>
                      {formatCurrency(row.adjustedAmount)}
                      {Number(row.adjustmentAmount) > 0 && (
                        <span className="block text-xs text-brand-700">
                          − {formatCurrency(row.adjustmentAmount)}
                        </span>
                      )}
                    </>
                  )}
                </TD>
                <TD align="right" numeric className="text-positive">
                  {row.paidAmount === null ? (
                    <span className="text-ink-faint">-</span>
                  ) : (
                    formatCurrency(row.paidAmount)
                  )}
                </TD>
                <TD
                  align="right"
                  numeric
                  className={Number(row.dueAmount) > 0 ? "font-semibold text-danger" : undefined}
                >
                  {row.dueAmount === null ? (
                    <span className="text-ink-faint">-</span>
                  ) : (
                    formatCurrency(row.dueAmount)
                  )}
                </TD>
                <TD>
                  {row.billStatus ? (
                    <BillStatusBadge status={row.billStatus} />
                  ) : (
                    <span className="text-xs text-ink-faint">No bill</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-faint">
        <span>Bill, paid and due are for {formatMonth(month)}.</span>
      </div>
      <div className="border-t border-line">
        <Pagination page={page} pageCount={pageCount} total={total} />
      </div>
    </Card>
  );
}

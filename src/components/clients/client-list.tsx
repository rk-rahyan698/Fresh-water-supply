import Link from "next/link";
import { ChevronRight, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ClientStatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { ClientWithRate } from "@/types/database";

/**
 * Client list, rendered as tappable cards on phones and as a table from `sm`
 * up. Collectors spend most of their day on this screen.
 */
export function ClientList({
  clients,
  basePath,
  page,
  pageCount,
  total,
  searching,
  emptyAction,
}: {
  clients: ClientWithRate[];
  /** "/clients" for admins, "/my/clients" for collectors. */
  basePath: string;
  page: number;
  pageCount: number;
  total: number;
  searching: boolean;
  emptyAction?: React.ReactNode;
}) {
  if (clients.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title={searching ? t.client.emptySearch : t.client.empty}
          description={
            searching ? "Try a different name, phone number or client code." : undefined
          }
          action={emptyAction}
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* Mobile: full-width rows with a big tap target. */}
      <ul className="divide-y divide-line sm:hidden">
        {clients.map((client) => (
          <li key={client.id}>
            <Link
              href={`${basePath}/${client.id}`}
              className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-canvas"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-ink">
                  {client.name}
                  {client.status === "inactive" && <ClientStatusBadge status={client.status} />}
                </p>
                <p className="mt-0.5 truncate text-xs text-ink-soft">
                  {client.client_code}
                  {client.phone ? ` · ${client.phone}` : ""}
                </p>
              </div>
              <span className="tnum shrink-0 text-sm font-semibold text-ink">
                {formatCurrency(client.monthly_bill)}
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
              <TH>{t.client.code}</TH>
              <TH>{t.client.phone}</TH>
              <TH>{t.client.address}</TH>
              <TH align="right">{t.client.monthlyBill}</TH>
              <TH>{t.client.status}</TH>
            </TR>
          </THead>
          <TBody>
            {clients.map((client) => (
              <TR key={client.id}>
                <TD>
                  <Link
                    href={`${basePath}/${client.id}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {client.name}
                  </Link>
                </TD>
                <TD className="text-ink-soft">{client.client_code}</TD>
                <TD className="text-ink-soft">
                  {client.phone ? (
                    <a href={`tel:${client.phone}`} className="hover:text-brand-600">
                      {client.phone}
                    </a>
                  ) : (
                    "-"
                  )}
                </TD>
                <TD className="max-w-xs truncate text-ink-soft">{client.address ?? "-"}</TD>
                <TD align="right" numeric>
                  {formatCurrency(client.monthly_bill)}
                </TD>
                <TD>
                  <ClientStatusBadge status={client.status} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>

      <div className="border-t border-line">
        <Pagination page={page} pageCount={pageCount} total={total} />
      </div>
    </Card>
  );
}

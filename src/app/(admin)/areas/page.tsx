import type { Metadata } from "next";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  MobileCard,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import {
  AddAreaButton,
  DeleteAreaButton,
  EditAreaButton,
} from "@/components/areas/area-dialogs";
import { getAreaClientCounts, listAreas } from "@/lib/queries/areas";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Areas" };

export default async function AreasPage() {
  const [areas, counts] = await Promise.all([listAreas(), getAreaClientCounts()]);
  const unassigned = (await getUnassignedCount()) ?? 0;

  return (
    <>
      <PageHeader
        title={t.area.many}
        description={t.area.hint}
        action={<AddAreaButton />}
      />

      <Card className="overflow-hidden">
        {areas.length === 0 ? (
          <EmptyState icon={MapPin} title={t.area.empty} action={<AddAreaButton />} />
        ) : (
          <>
            {/* Mobile */}
            <div className="sm:hidden">
              {areas.map((area) => (
                <MobileCard key={area.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{area.name}</p>
                      {area.description && (
                        <p className="mt-0.5 truncate text-xs text-ink-soft">{area.description}</p>
                      )}
                      <p className="mt-1 text-xs text-ink-faint">
                        {counts.get(area.id) ?? 0} {t.area.clients.toLowerCase()}
                      </p>
                    </div>
                    <Badge tone={area.is_active ? "positive" : "neutral"}>
                      {area.is_active ? t.area.active : t.area.inactive}
                    </Badge>
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <EditAreaButton area={area} />
                    <DeleteAreaButton area={area} clientCount={counts.get(area.id) ?? 0} />
                    <Link
                      href={`/clients?area=${area.id}`}
                      className="ml-auto rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                    >
                      {t.area.clients}
                    </Link>
                  </div>
                </MobileCard>
              ))}
            </div>

            {/* Desktop */}
            <TableWrap className="hidden sm:block">
              <Table>
                <THead>
                  <TR>
                    <TH>{t.area.name}</TH>
                    <TH>{t.area.description}</TH>
                    <TH align="right">{t.area.clients}</TH>
                    <TH>{t.client.status}</TH>
                    <TH align="right">{t.common.actions}</TH>
                  </TR>
                </THead>
                <TBody>
                  {areas.map((area) => (
                    <TR key={area.id}>
                      <TD className="font-medium">{area.name}</TD>
                      <TD className="max-w-xs truncate text-ink-soft">
                        {area.description ?? "-"}
                      </TD>
                      <TD align="right" numeric>
                        <Link
                          href={`/clients?area=${area.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {counts.get(area.id) ?? 0}
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={area.is_active ? "positive" : "neutral"}>
                          {area.is_active ? t.area.active : t.area.inactive}
                        </Badge>
                      </TD>
                      <TD align="right">
                        <div className="flex items-center justify-end gap-1.5">
                          <EditAreaButton area={area} />
                          <DeleteAreaButton area={area} clientCount={counts.get(area.id) ?? 0} />
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </>
        )}
      </Card>

      {unassigned > 0 && (
        <p className="mt-3 rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-ink">
          <Link href="/clients?area=none" className="font-medium underline">
            {unassigned} client{unassigned === 1 ? "" : "s"}
          </Link>{" "}
          {unassigned === 1 ? "has" : "have"} no area yet. They still appear everywhere, and are
          reported under &ldquo;{t.area.unassigned}&rdquo; in the area report.
        </p>
      )}
    </>
  );
}

/** Clients with no area - surfaced so nobody is quietly left out of area reports. */
async function getUnassignedCount(): Promise<number> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { count } = await supabase
    .from("clients")
    .select("*", { count: "exact", head: true })
    .is("area_id", null);
  return count ?? 0;
}

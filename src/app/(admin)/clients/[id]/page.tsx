import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  ClientSummaryCard,
  CurrentBillCard,
  PaymentHistoryCard,
} from "@/components/clients/client-detail";
import {
  ClientAdminActions,
  GenerateClientBillButton,
} from "@/components/clients/client-admin-actions";
import {
  ChangeAreaButton,
  ChangeRateButton,
} from "@/components/clients/client-rate-area-dialogs";
import { BillAdjustmentButton } from "@/components/bills/bill-adjustment-dialog";
import { BillHistoryMatrix } from "@/components/clients/bill-history-matrix";
import { UrlSelect } from "@/components/filters/url-controls";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import {
  getClient,
  getClientBillMatrix,
  getClientBillYears,
  getClientBills,
  getClientOutstanding,
  getClientPayments,
  getClientRateHistory,
} from "@/lib/queries/clients";
import { listAreas } from "@/lib/queries/areas";
import { dhakaCurrentMonth, formatCurrency, formatMonth } from "@/lib/format";
import { t } from "@/lib/i18n";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const client = await getClient(id);
  return { title: client ? client.name : "Client" };
}

export default async function AdminClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { id } = await params;
  const { year: yearParam } = await searchParams;

  const client = await getClient(id);
  if (!client) notFound();

  const currentMonth = dhakaCurrentMonth();
  const currentYear = Number(currentMonth.slice(0, 4));

  // Which years exist first, so the matrix only ever loads a bounded window
  // rather than a decade of bills (spec section 11).
  const years = await getClientBillYears(id);
  const endYear = Number(yearParam) || years[0] || currentYear;
  const windowYears = [endYear - 2, endYear - 1, endYear].filter((y) => years.includes(y));
  const columns = windowYears.length > 0 ? windowYears : [endYear];

  const [bills, payments, outstanding, matrix, areas, rates] = await Promise.all([
    getClientBills(id, 12),
    getClientPayments(id),
    getClientOutstanding(id),
    getClientBillMatrix(id, columns[0], columns[columns.length - 1]),
    listAreas(false),
    getClientRateHistory(id),
  ]);

  const currentBill = bills.find((bill) => bill.billing_month === currentMonth) ?? null;

  return (
    <>
      <Link
        href="/clients"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {t.client.many}
      </Link>

      <div className="space-y-3">
        <ClientSummaryCard
          client={client}
          outstanding={outstanding}
          areaName={client.areas?.name}
          actions={<ClientAdminActions client={client} />}
        />

        {/* Admin-only rate and area controls (spec sections 1, 19, 25, 33) */}
        <Card>
          <CardHeader
            title="Billing &amp; area"
            description="Changes here affect future bills and reporting only."
          />
          <CardBody className="flex flex-wrap items-center gap-2">
            <ChangeRateButton
              clientId={client.id}
              clientName={client.name}
              currentRate={Number(client.monthly_bill)}
            />
            <ChangeAreaButton
              clientId={client.id}
              currentAreaId={client.area_id}
              areas={areas}
            />
            {rates.length > 0 && (
              <p className="w-full text-xs text-ink-faint">
                {t.rate.history}:{" "}
                {rates
                  .slice(0, 3)
                  .map(
                    (r) =>
                      `${formatCurrency(Number(r.monthly_bill))} ${t.rate.appliesFrom.toLowerCase()} ${formatMonth(r.effective_from)}`,
                  )
                  .join(" · ")}
              </p>
            )}
          </CardBody>
        </Card>

        {/* Current month first (spec section 26) */}
        <CurrentBillCard
          client={client}
          bill={currentBill}
          billingMonth={currentMonth}
          canCollect
          approvedBy={currentBill?.adjuster?.full_name}
          adminAction={
            client.status === "active" ? (
              <GenerateClientBillButton clientId={client.id} billingMonth={currentMonth} />
            ) : undefined
          }
          adjustmentAction={
            currentBill ? (
              <BillAdjustmentButton bill={currentBill} clientName={client.name} size="md" />
            ) : undefined
          }
        />

        {/* Long-term history as Year x Month (spec sections 6-11) */}
        <BillHistoryMatrix
          clientName={client.name}
          cells={matrix}
          years={years}
          selectedYears={columns}
          onYearChange={
            years.length > 1 ? (
              <UrlSelect
                param="year"
                value={String(endYear)}
                options={years.map((y) => ({ value: String(y), label: String(y) }))}
                ariaLabel="Year"
                className="w-28"
              />
            ) : undefined
          }
        />

        <PaymentHistoryCard payments={payments} />
      </div>
    </>
  );
}

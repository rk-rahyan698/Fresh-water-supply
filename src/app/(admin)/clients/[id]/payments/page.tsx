import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, User } from "lucide-react";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { BillFinancialSummary } from "@/components/bills/bill-summary";
import { BillAdjustmentButton } from "@/components/bills/bill-adjustment-dialog";
import { CollectPaymentButton } from "@/components/payments/collect-payment-dialog";
import { ClientPaymentsView } from "@/components/clients/client-payments-view";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getClient,
  getClientBillMatrix,
  getClientBillYears,
  getClientBills,
} from "@/lib/queries/clients";
import {
  getClientFinancialSummary,
  getClientPaymentHistory,
} from "@/lib/queries/collection-report";
import { dhakaCurrentMonth, formatCurrency, formatMonth } from "@/lib/format";
import { env } from "@/lib/env";
import { t } from "@/lib/i18n";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const client = await getClient(id);
  return { title: client ? `${client.name} · Payments` : "Payments" };
}

/**
 * The client's payment record (spec sections 20, 21).
 *
 * Profile answers "who is this and what do they owe". This answers "what have
 * they paid, when, and to whom" - plus payment entry and the PDF exports.
 */
export default async function ClientPaymentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  const currentMonth = dhakaCurrentMonth();
  const currentYear = Number(currentMonth.slice(0, 4));

  const years = await getClientBillYears(id);
  const endYear = years[0] ?? currentYear;
  const windowYears = [endYear - 2, endYear - 1, endYear].filter((y) => years.includes(y));
  const columns = windowYears.length > 0 ? windowYears : [endYear];

  const [bills, payments, summary, billCells] = await Promise.all([
    getClientBills(id, 12),
    getClientPaymentHistory(id),
    getClientFinancialSummary(id),
    getClientBillMatrix(id, columns[0], columns[columns.length - 1]),
  ]);

  const currentBill = bills.find((bill) => bill.billing_month === currentMonth) ?? null;

  return (
    <>
      <Link
        href={`/clients/${client.id}`}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {client.name}
      </Link>

      <PageHeader
        title={`${client.name} · ${t.clientPayments.title}`}
        description={`${client.client_code}${client.areas?.name ? ` · ${client.areas.name}` : ""} · ${t.clientPayments.description}`}
        action={
          <LinkButton href={`/clients/${client.id}`} variant="secondary" size="sm">
            <User className="size-4" />
            {t.collections.profile}
          </LinkButton>
        }
      />

      {/* Lifetime position, so the exports and the screen agree */}
      <div className="mb-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label={t.clientPayments.totalBilled}
          value={formatCurrency(summary.original_amount)}
          sub={`${summary.bill_count} bills`}
        />
        <StatCard
          label={t.clientPayments.totalAdjustments}
          value={formatCurrency(summary.adjustment_amount)}
          tone={summary.adjustment_amount > 0 ? "brand" : "default"}
        />
        <StatCard
          label={t.clientPayments.totalPaid}
          value={formatCurrency(summary.collected_amount)}
          tone="positive"
        />
        <StatCard
          label={t.clientPayments.outstanding}
          value={formatCurrency(summary.outstanding)}
          tone={summary.outstanding > 0 ? "danger" : "positive"}
        />
      </div>

      {/* Current month, with payment entry right beside it */}
      <Card className="mb-3">
        <CardHeader
          title={formatMonth(currentMonth)}
          description={t.bill.financialSummary}
          action={
            currentBill ? (
              <BillAdjustmentButton bill={currentBill} clientName={client.name} />
            ) : undefined
          }
        />
        <CardBody>
          {currentBill ? (
            <>
              <BillFinancialSummary
                bill={currentBill}
                approvedBy={currentBill.adjuster?.full_name}
              />
              <div className="mt-4">
                <CollectPaymentButton
                  clientId={client.id}
                  clientName={client.name}
                  bill={currentBill}
                  size="lg"
                  fullWidth
                />
              </div>
            </>
          ) : (
            <EmptyState title={t.bill.noBillForMonth} description={t.bill.askAdmin} />
          )}
        </CardBody>
      </Card>

      <ClientPaymentsView
        client={{
          name: client.name,
          code: client.client_code,
          phone: client.phone,
          address: client.address,
          areaName: client.areas?.name ?? null,
          monthlyBill: Number(client.monthly_bill),
          businessName: env.businessName,
        }}
        payments={payments}
        summary={summary}
        billCells={billCells}
      />
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  BillHistoryCard,
  ClientSummaryCard,
  CurrentBillCard,
  PaymentHistoryCard,
} from "@/components/clients/client-detail";
import {
  getClient,
  getClientBills,
  getClientOutstanding,
  getClientPayments,
} from "@/lib/queries/clients";
import { dhakaCurrentMonth } from "@/lib/format";
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

export default async function CollectorClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  const currentMonth = dhakaCurrentMonth();
  const [bills, payments, outstanding] = await Promise.all([
    getClientBills(id),
    // RLS scopes this to the signed-in collector's own payments.
    getClientPayments(id),
    getClientOutstanding(id),
  ]);

  const currentBill = bills.find((bill) => bill.billing_month === currentMonth) ?? null;

  return (
    <>
      <Link
        href="/my/clients"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {t.client.many}
      </Link>

      <div className="space-y-3">
        <ClientSummaryCard client={client} outstanding={outstanding} />

        <CurrentBillCard
          client={client}
          bill={currentBill}
          billingMonth={currentMonth}
          canCollect
        />

        <BillHistoryCard client={client} bills={bills} canCollect />

        <PaymentHistoryCard payments={payments} scopedToSelf />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { PaymentsTable } from "@/components/payments/payments-table";
import {
  FilterBar,
  UrlDateInput,
  UrlSearchInput,
  UrlSelect,
} from "@/components/filters/url-controls";
import { listPayments } from "@/lib/queries/payments";
import { listCollectors } from "@/lib/queries/reports";
import { listAreas } from "@/lib/queries/areas";
import { dhakaToday, monthOptions, toMonthStart } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { PaymentMethod } from "@/types/database";

export const metadata: Metadata = { title: "Collections" };

const METHOD_OPTIONS = [
  { value: "", label: `${t.common.all} methods` },
  { value: "cash", label: t.payment.cash },
  { value: "bank", label: t.payment.bank },
  { value: "mobile_banking", label: t.payment.mobileBanking },
  { value: "other", label: t.payment.other },
];

export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    month?: string;
    collector?: string;
    method?: string;
    q?: string;
    area?: string;
    page?: string;
    voided?: string;
  }>;
}) {
  const params = await searchParams;
  const page = Number(params.page ?? 1);
  const includeVoided = params.voided === "1";

  const [collectors, areas] = await Promise.all([listCollectors(), listAreas()]);

  const { payments, total, pageCount, sum } = await listPayments({
    from: params.from,
    to: params.to,
    billingMonth: params.month ? toMonthStart(params.month) : undefined,
    collectorId: params.collector || undefined,
    method: (params.method as PaymentMethod) || undefined,
    areaId: params.area || undefined,
    search: params.q,
    includeVoided,
    page,
  });

  return (
    <>
      <PageHeader
        title={t.nav.collections}
        description="Every payment recorded, with the collector who took it."
      />

      <FilterBar
        alwaysVisible={
          <UrlSearchInput
            initialValue={params.q ?? ""}
            placeholder={`${t.common.search} ${t.client.one.toLowerCase()}`}
            className="min-w-0 flex-1"
          />
        }
      >
        <UrlDateInput param="from" value={params.from ?? ""} label={t.common.from} max={dhakaToday()} className="w-full sm:w-40" />
        <UrlDateInput param="to" value={params.to ?? ""} label={t.common.to} max={dhakaToday()} className="w-full sm:w-40" />
        <UrlSelect
          param="month"
          value={params.month ?? ""}
          label={t.bill.billingMonth}
          options={[{ value: "", label: `${t.common.all} months` }, ...monthOptions(18)]}
          className="w-full sm:w-40"
        />
        <UrlSelect
          param="collector"
          value={params.collector ?? ""}
          label={t.submission.collector}
          options={[
            { value: "", label: `${t.common.all} collectors` },
            ...collectors.map((collector) => ({
              value: collector.id,
              label: collector.full_name,
            })),
          ]}
          className="w-full sm:w-44"
        />
        <UrlSelect
          param="area"
          value={params.area ?? ""}
          label={t.area.one}
          options={[
            { value: "", label: t.area.all },
            ...areas.map((a) => ({ value: a.id, label: a.name })),
          ]}
          className="w-full sm:w-40"
        />
        <UrlSelect
          param="method"
          value={params.method ?? ""}
          label={t.payment.method}
          options={METHOD_OPTIONS}
          className="w-full sm:w-36"
        />
        <UrlSelect
          param="voided"
          value={params.voided ?? ""}
          label={t.payment.voided}
          options={[
            { value: "", label: "Hidden" },
            { value: "1", label: "Shown" },
          ]}
          className="w-full sm:w-28"
        />
      </FilterBar>

      <PaymentsTable
        payments={payments}
        page={page}
        pageCount={pageCount}
        total={total}
        sum={sum}
        canVoid
        emptyDescription="No payments match these filters. Try widening the date range."
      />
    </>
  );
}

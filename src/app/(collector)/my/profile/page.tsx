import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { ProfileForm } from "@/components/users/profile-form";
import { requireUser } from "@/lib/auth";
import { getCollectorStats } from "@/lib/queries/reports";
import { env } from "@/lib/env";
import { CURRENCY_SYMBOL, TIMEZONE, formatCurrency } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Profile" };

export default async function MyProfilePage() {
  const ctx = await requireUser();
  const stats = await getCollectorStats(ctx.userId);

  return (
    <>
      <PageHeader title={t.nav.profile} />

      <div className="space-y-3">
        <Card>
          <CardHeader title={t.settings.account} />
          <CardBody>
            <ProfileForm profile={ctx.profile} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Your totals" description="All time" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <Row
                label={t.report.totalCollected}
                value={`${formatCurrency(stats.total_collection)} · ${stats.total_count} ${t.dashboard.paymentsCount}`}
              />
              <Row label={t.submission.submitted} value={formatCurrency(stats.total_submitted)} />
              <Row label={t.submission.unsubmitted} value={formatCurrency(stats.unsubmitted)} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={env.businessName} />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <Row label={t.settings.currency} value={`Bangladeshi Taka (${CURRENCY_SYMBOL})`} />
              <Row label={t.settings.timezone} value={TIMEZONE} />
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2.5 last:border-b-0 last:pb-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="tnum font-medium text-ink">{value}</dd>
    </div>
  );
}

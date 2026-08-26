import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { ProfileForm } from "@/components/users/profile-form";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { CURRENCY_SYMBOL, TIMEZONE, formatCurrency, formatDateLong, dhakaToday } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireAdmin();

  return (
    <>
      <PageHeader title={t.settings.title} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title={t.settings.account} description="Your own details." />
          <CardBody>
            <ProfileForm profile={ctx.profile} />
          </CardBody>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader
              title={t.settings.business}
              description="Set from environment variables at deploy time."
            />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <Row label={t.settings.businessName} value={env.businessName} />
                <Row
                  label={t.settings.currency}
                  value={`Bangladeshi Taka (${CURRENCY_SYMBOL}) · ${formatCurrency(12500)}`}
                />
                <Row
                  label={t.settings.timezone}
                  value={`${TIMEZONE} · today is ${formatDateLong(dhakaToday())}`}
                />
              </dl>
              <p className="mt-4 rounded-xl bg-canvas px-3 py-2.5 text-xs text-ink-soft">
                To change the business name, set{" "}
                <code className="rounded bg-black/6 px-1 py-0.5">NEXT_PUBLIC_BUSINESS_NAME</code> in
                your environment and redeploy.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={t.settings.dataIntegrity}
              description="Rules the database enforces, not just the screens."
            />
            <CardBody>
              <ul className="space-y-2.5 text-sm text-ink-soft">
                <Rule>Payments are never edited or deleted - only voided, with a reason.</Rule>
                <Rule>A payment can never exceed the outstanding due on its bill.</Rule>
                <Rule>A client cannot get two bills for the same month.</Rule>
                <Rule>A bill&apos;s paid amount is recomputed from its payments, never typed in.</Rule>
                <Rule>A collector cannot submit more cash than they actually hold.</Rule>
                <Rule>Every payment, bill and submission is written to the audit log.</Rule>
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2.5 last:border-b-0 last:pb-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-positive" />
      <span>{children}</span>
    </li>
  );
}

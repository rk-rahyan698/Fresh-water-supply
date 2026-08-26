import type { Metadata } from "next";
import Link from "next/link";
import { Search, Wallet, Banknote, HandCoins, CalendarDays, ArrowRight } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/button";
import { PaymentMethodBadge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth";
import { getCollectorStats } from "@/lib/queries/reports";
import { listPayments } from "@/lib/queries/payments";
import { dhakaCurrentMonth, formatCurrency, formatDate, formatMonth } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Dashboard" };

export default async function CollectorDashboardPage() {
  const ctx = await requireUser();
  const month = dhakaCurrentMonth();

  const [stats, recent] = await Promise.all([
    getCollectorStats(ctx.userId, month),
    listPayments({ collectorId: ctx.userId, pageSize: 8 }),
  ]);

  return (
    <>
      <PageHeader
        title={`Hello, ${ctx.profile.full_name.split(" ")[0]}`}
        description={`${formatMonth(month)} · ${t.app.tagline}`}
      />

      {/* The one button a collector needs most. */}
      <Link
        href="/my/clients"
        className="mb-3 flex items-center gap-3 rounded-2xl bg-brand-600 px-4 py-4 text-white shadow-sm transition-colors hover:bg-brand-700"
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
          <Search className="size-5.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">{t.nav.collectPayment}</span>
          <span className="block text-sm text-white/80">Find a client and record their payment</span>
        </span>
        <ArrowRight className="size-5 shrink-0 text-white/70" />
      </Link>

      <div className="grid grid-cols-2 gap-2.5">
        <StatCard
          label={t.dashboard.todayCollection}
          value={formatCurrency(stats.today_collection)}
          sub={`${stats.today_count} ${t.dashboard.paymentsCount}`}
          icon={CalendarDays}
          tone="brand"
        />
        <StatCard
          label={`${formatMonth(month)} ${t.dashboard.monthCollected}`}
          value={formatCurrency(stats.month_collection)}
          sub={`${stats.month_count} ${t.dashboard.paymentsCount}`}
          icon={HandCoins}
        />
        <StatCard
          label={t.submission.submitted}
          value={formatCurrency(stats.total_submitted)}
          sub="All time"
          icon={Banknote}
          tone="positive"
          href="/my/submissions"
        />
        <StatCard
          label={t.submission.unsubmitted}
          value={formatCurrency(stats.unsubmitted)}
          sub="Cash in your hand"
          icon={Wallet}
          tone={stats.unsubmitted > 0 ? "warning" : "positive"}
          href="/my/submissions"
        />
      </div>

      <Card className="mt-3 overflow-hidden">
        <CardHeader
          title="Your recent collections"
          action={
            <LinkButton href="/my/collections" variant="secondary" size="sm">
              {t.common.viewAll}
              <ArrowRight className="size-4" />
            </LinkButton>
          }
        />
        {recent.payments.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title={t.payment.empty}
            description="Payments you record will show up here."
            action={
              <LinkButton href="/my/clients" size="sm">
                {t.nav.collectPayment}
              </LinkButton>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {recent.payments.map((payment) => (
              <li key={payment.id}>
                <Link
                  href={`/receipt/${payment.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors active:bg-canvas sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {payment.clients?.name ?? "-"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-soft">
                      {formatDate(payment.payment_date)}
                      {payment.monthly_bills
                        ? ` · ${formatMonth(payment.monthly_bills.billing_month)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <PaymentMethodBadge method={payment.payment_method} />
                    <span
                      className={`tnum text-sm font-semibold ${
                        payment.voided_at ? "text-ink-faint line-through" : "text-ink"
                      }`}
                    >
                      {formatCurrency(payment.amount)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

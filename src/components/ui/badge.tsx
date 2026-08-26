import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { BillStatus, ClientStatus, PaymentMethod, UserRole } from "@/types/database";

type Tone = "neutral" | "positive" | "warning" | "danger" | "brand";

const TONES: Record<Tone, string> = {
  neutral: "bg-black/6 text-ink-soft",
  positive: "bg-positive-soft text-positive",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  brand: "bg-brand-50 text-brand-700",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const BILL_TONE: Record<BillStatus, Tone> = {
  unpaid: "danger",
  partial: "warning",
  paid: "positive",
};

const BILL_LABEL: Record<BillStatus, string> = {
  unpaid: t.bill.unpaid,
  partial: t.bill.partial,
  paid: t.bill.paidStatus,
};

export function BillStatusBadge({ status }: { status: BillStatus }) {
  return <Badge tone={BILL_TONE[status]}>{BILL_LABEL[status]}</Badge>;
}

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  return (
    <Badge tone={status === "active" ? "positive" : "neutral"}>
      {status === "active" ? t.client.active : t.client.inactive}
    </Badge>
  );
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: t.payment.cash,
  bank: t.payment.bank,
  mobile_banking: t.payment.mobileBanking,
  other: t.payment.other,
};

export function methodLabel(method: PaymentMethod): string {
  return METHOD_LABEL[method];
}

export function PaymentMethodBadge({ method }: { method: PaymentMethod }) {
  return <Badge tone={method === "cash" ? "brand" : "neutral"}>{METHOD_LABEL[method]}</Badge>;
}

export function RoleBadge({ role }: { role: UserRole }) {
  return (
    <Badge tone={role === "admin" ? "brand" : "neutral"}>
      {role === "admin" ? t.users.admin : t.users.collector}
    </Badge>
  );
}

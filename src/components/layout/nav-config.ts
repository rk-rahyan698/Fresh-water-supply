import {
  LayoutDashboard,
  Users,
  ReceiptText,
  HandCoins,
  Banknote,
  FileWarning,
  UserCheck,
  CalendarRange,
  CalendarDays,
  UserCog,
  Settings,
  Wallet,
  CircleUser,
  MoreHorizontal,
} from "lucide-react";
import { t } from "@/lib/i18n";
import type { UserRole } from "@/types/database";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Match nested routes too, e.g. /clients/<id>. */
  prefix?: boolean;
}

export interface NavSection {
  heading?: string;
  items: NavItem[];
}

const ADMIN_SECTIONS: NavSection[] = [
  {
    items: [
      { href: "/dashboard", label: t.nav.dashboard, icon: LayoutDashboard },
      { href: "/clients", label: t.nav.clients, icon: Users, prefix: true },
      { href: "/bills", label: t.nav.bills, icon: ReceiptText },
      { href: "/collections", label: t.nav.collections, icon: HandCoins },
      { href: "/submissions", label: t.nav.submissions, icon: Banknote },
    ],
  },
  {
    heading: t.nav.reports,
    items: [
      { href: "/reports/due", label: t.nav.dueReport, icon: FileWarning },
      { href: "/reports/collector", label: t.nav.collectorReport, icon: UserCheck },
      { href: "/reports/monthly", label: t.nav.monthlyReport, icon: CalendarRange },
      { href: "/reports/daily", label: t.nav.dailyReport, icon: CalendarDays },
    ],
  },
  {
    items: [
      { href: "/users", label: t.nav.users, icon: UserCog },
      { href: "/settings", label: t.nav.settings, icon: Settings },
    ],
  },
];

const COLLECTOR_SECTIONS: NavSection[] = [
  {
    items: [
      { href: "/my/dashboard", label: t.nav.dashboard, icon: LayoutDashboard },
      { href: "/my/clients", label: t.nav.clients, icon: Users, prefix: true },
      { href: "/my/collections", label: t.nav.myCollections, icon: HandCoins },
      { href: "/my/submissions", label: t.nav.mySubmissions, icon: Wallet },
      { href: "/my/profile", label: t.nav.profile, icon: CircleUser },
    ],
  },
];

/** The four destinations that earn a permanent slot on a phone screen. */
const ADMIN_TABS: NavItem[] = [
  { href: "/dashboard", label: t.nav.dashboard, icon: LayoutDashboard },
  { href: "/clients", label: t.nav.clients, icon: Users, prefix: true },
  { href: "/collections", label: t.nav.collections, icon: HandCoins },
  { href: "/submissions", label: t.nav.submissions, icon: Banknote },
];

const COLLECTOR_TABS: NavItem[] = [
  { href: "/my/dashboard", label: t.nav.dashboard, icon: LayoutDashboard },
  { href: "/my/clients", label: t.nav.clients, icon: Users, prefix: true },
  { href: "/my/collections", label: t.nav.myCollections, icon: HandCoins },
  { href: "/my/submissions", label: t.nav.mySubmissions, icon: Wallet },
];

export const MORE_ICON = MoreHorizontal;

export function navSectionsFor(role: UserRole): NavSection[] {
  return role === "admin" ? ADMIN_SECTIONS : COLLECTOR_SECTIONS;
}

export function navTabsFor(role: UserRole): NavItem[] {
  return role === "admin" ? ADMIN_TABS : COLLECTOR_TABS;
}

export function isActivePath(pathname: string, item: NavItem): boolean {
  return item.prefix ? pathname === item.href || pathname.startsWith(`${item.href}/`) : pathname === item.href;
}

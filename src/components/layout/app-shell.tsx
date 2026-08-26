"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Droplets, LogOut, Menu, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { signOutAction } from "@/lib/actions/auth";
import {
  MORE_ICON,
  isActivePath,
  navSectionsFor,
  navTabsFor,
  type NavItem,
} from "./nav-config";
import type { UserRole } from "@/types/database";

interface AppShellProps {
  role: UserRole;
  userName: string;
  businessName: string;
  children: React.ReactNode;
}

export function AppShell({ role, userName, businessName, children }: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sections = navSectionsFor(role);
  const tabs = navTabsFor(role);

  // Close the drawer whenever navigation happens. Adjusted during render
  // rather than in an effect, so the drawer never paints on the new page.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setDrawerOpen(false);
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const currentTitle =
    sections
      .flatMap((section) => section.items)
      .find((item) => isActivePath(pathname, item))?.label ?? businessName;

  return (
    <div className="min-h-dvh">
      {/* ---------------- Desktop sidebar ---------------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-surface lg:flex">
        <Brand businessName={businessName} />
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {sections.map((section, index) => (
            <div key={section.heading ?? index} className={index > 0 ? "mt-5" : undefined}>
              {section.heading && (
                <p className="px-3 pb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
                  {section.heading}
                </p>
              )}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} active={isActivePath(pathname, item)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <UserFooter userName={userName} role={role} />
      </aside>

      {/* ---------------- Mobile drawer ---------------- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/45 animate-[fade-in_150ms_ease-out]"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t.nav.menu}
            className="relative flex h-full w-72 max-w-[85%] flex-col bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-line pr-2">
              <Brand businessName={businessName} />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label={t.common.close}
                className="rounded-lg p-2 text-ink-faint hover:bg-black/5 hover:text-ink"
              >
                <X className="size-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-3">
              {sections.map((section, index) => (
                <div key={section.heading ?? index} className={index > 0 ? "mt-5" : undefined}>
                  {section.heading && (
                    <p className="px-3 pb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
                      {section.heading}
                    </p>
                  )}
                  <ul className="space-y-0.5">
                    {section.items.map((item) => (
                      <li key={item.href}>
                        <NavLink item={item} active={isActivePath(pathname, item)} large />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <UserFooter userName={userName} role={role} />
          </div>
        </div>
      )}

      {/* ---------------- Main column ---------------- */}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t.nav.menu}
            className="rounded-xl p-2.5 text-ink-soft transition-colors hover:bg-black/5 hover:text-ink"
          >
            <Menu className="size-5" />
          </button>
          <p className="flex-1 truncate text-base font-semibold text-ink">{currentTitle}</p>
          <form action={signOutAction}>
            <button
              type="submit"
              aria-label={t.nav.signOut}
              className="rounded-xl p-2.5 text-ink-soft transition-colors hover:bg-black/5 hover:text-ink"
            >
              <LogOut className="size-5" />
            </button>
          </form>
        </header>

        {/* pb-20 leaves room for the bottom tab bar on phones. */}
        <main className="mx-auto w-full max-w-7xl px-3 pt-4 pb-24 sm:px-5 sm:pt-6 lg:pb-10">
          {children}
        </main>
      </div>

      {/* ---------------- Mobile bottom tabs ---------------- */}
      <nav
        aria-label={t.nav.menu}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/97 backdrop-blur lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {tabs.map((item) => {
            const active = isActivePath(pathname, item);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition-colors",
                    active ? "text-brand-600" : "text-ink-faint",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon className="size-5.5" />
                  <span className="w-full truncate text-center leading-tight">{item.label}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex h-16 w-full flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium text-ink-faint"
            >
              <MORE_ICON className="size-5.5" />
              <span className="leading-tight">{t.nav.menu}</span>
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}

function Brand({ businessName }: { businessName: string }) {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-line px-4 lg:border-b">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
        <Droplets className="size-4.5" />
      </span>
      <span className="min-w-0 truncate text-sm font-semibold text-ink">{businessName}</span>
    </div>
  );
}

function NavLink({ item, active, large }: { item: NavItem; active: boolean; large?: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 font-medium transition-colors",
        large ? "h-12 text-[15px]" : "h-10 text-sm",
        active ? "bg-brand-50 text-brand-700" : "text-ink-soft hover:bg-black/4 hover:text-ink",
      )}
    >
      <Icon className={cn("shrink-0", active ? "text-brand-600" : "text-ink-faint", "size-5")} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function UserFooter({ userName, role }: { userName: string; role: UserRole }) {
  return (
    <div className="border-t border-line p-3">
      <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
          {userName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{userName}</p>
          <p className="text-xs text-ink-faint">{role === "admin" ? t.users.admin : t.users.collector}</p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            aria-label={t.nav.signOut}
            title={t.nav.signOut}
            className="rounded-lg p-2 text-ink-faint transition-colors hover:bg-black/5 hover:text-danger"
          >
            <LogOut className="size-4.5" />
          </button>
        </form>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { Droplets } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { env } from "@/lib/env";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Sign in" };

const ERROR_MESSAGES: Record<string, string> = {
  inactive: t.auth.inactive,
};

export default async function LoginPage({
  searchParams,
}: {
  // Next 16 hands these over as a promise.
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/20">
            <Droplets className="size-7" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{env.businessName}</h1>
          <p className="mt-1 text-sm text-ink-soft">{t.auth.welcome}</p>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          <LoginForm next={next} initialError={error ? ERROR_MESSAGES[error] : undefined} />
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          {t.app.tagline} · {env.businessName}
        </p>
      </div>
    </main>
  );
}

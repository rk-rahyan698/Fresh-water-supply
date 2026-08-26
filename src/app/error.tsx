"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toFriendlyMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";

/**
 * Last line of defence. Users see a sentence they can act on; the raw error
 * goes to the server logs, never to the screen.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled application error:", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle className="size-6" />
        </div>
        <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
        <p className="mt-2 text-sm text-ink-soft">{toFriendlyMessage(error)}</p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-ink-faint">Reference: {error.digest}</p>
        )}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button onClick={reset} fullWidth className="sm:w-auto">
            {t.common.retry}
          </Button>
          <Link
            href="/"
            className="inline-flex h-11 items-center justify-center rounded-xl border border-line bg-white px-4 text-sm font-medium text-ink hover:bg-canvas"
          >
            {t.nav.dashboard}
          </Link>
        </div>
      </div>
    </main>
  );
}

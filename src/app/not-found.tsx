import Link from "next/link";
import { SearchX } from "lucide-react";
import { t } from "@/lib/i18n";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <SearchX className="size-6" />
        </div>
        <h1 className="text-lg font-semibold text-ink">Page not found</h1>
        <p className="mt-2 text-sm text-ink-soft">
          That page does not exist, or the record was removed.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-brand-600 px-5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t.nav.dashboard}
        </Link>
      </div>
    </main>
  );
}

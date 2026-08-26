"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";
import { t } from "@/lib/i18n";

/** Page controls that preserve whatever filters are already in the URL. */
export function Pagination({
  page,
  pageCount,
  total,
}: {
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (pageCount <= 1) {
    return (
      <p className="px-4 py-3 text-xs text-ink-faint">
        {total} {total === 1 ? "record" : "records"}
      </p>
    );
  }

  const goTo = (nextPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(nextPage));
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <p className="text-xs text-ink-faint">
        {t.common.page} {page} {t.common.of} {pageCount} · {total} records
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
          aria-label={t.common.previous}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pageCount}
          onClick={() => goTo(page + 1)}
          aria-label={t.common.next}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

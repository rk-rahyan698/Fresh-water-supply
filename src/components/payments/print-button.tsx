"use client";

import { useRouter } from "next/navigation";
import { Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export function ReceiptActions({ backHref }: { backHref: string }) {
  const router = useRouter();

  return (
    <div className="no-print mb-4 flex items-center justify-between gap-2">
      <Button variant="ghost" size="sm" onClick={() => router.push(backHref)}>
        <ArrowLeft className="size-4" />
        {t.common.back}
      </Button>
      <Button size="sm" onClick={() => window.print()}>
        <Printer className="size-4" />
        {t.common.print} {t.payment.receipt.toLowerCase()}
      </Button>
    </div>
  );
}

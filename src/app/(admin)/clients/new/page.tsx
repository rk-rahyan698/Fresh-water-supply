import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { ClientForm } from "@/components/clients/client-form";
import { suggestClientCode } from "@/lib/queries/clients";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Add client" };

export default async function NewClientPage() {
  // Saves the owner from inventing a code every time.
  const suggestedCode = await suggestClientCode();

  return (
    <>
      <Link
        href="/clients"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {t.client.many}
      </Link>
      <PageHeader title={t.client.add} description="Add a client to start billing them monthly." />
      <ClientForm suggestedCode={suggestedCode} />
    </>
  );
}

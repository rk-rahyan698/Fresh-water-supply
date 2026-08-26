import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { ClientForm } from "@/components/clients/client-form";
import { getClient } from "@/lib/queries/clients";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Edit client" };

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  return (
    <>
      <Link
        href={`/clients/${client.id}`}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {client.name}
      </Link>
      <PageHeader
        title={t.client.edit}
        description="Changing the monthly bill affects future bills only - bills already generated keep their amount."
      />
      <ClientForm client={client} />
    </>
  );
}

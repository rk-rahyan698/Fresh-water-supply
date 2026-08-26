"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Power, Trash2, FilePlus2 } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { deleteClientAction, setClientStatusAction } from "@/lib/actions/clients";
import { generateClientBillAction } from "@/lib/actions/payments";
import { formatMonth } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Client } from "@/types/database";

export function ClientAdminActions({ client }: { client: Client }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  const isActive = client.status === "active";

  const toggleStatus = async () => {
    const confirmed = await confirm({
      title: isActive ? t.client.deactivate : t.client.activate,
      body: isActive ? t.client.deactivateConfirm : t.client.activateConfirm,
      confirmLabel: isActive ? t.client.deactivate : t.client.activate,
      tone: isActive ? "danger" : "primary",
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await setClientStatusAction(client.id, isActive ? "inactive" : "active");
      if (result.ok) {
        toast.success(isActive ? "Client deactivated" : "Client activated");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const remove = async () => {
    const confirmed = await confirm({
      title: t.common.delete,
      body: t.client.deleteConfirm,
      confirmLabel: t.common.delete,
      tone: "danger",
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await deleteClientAction(client.id);
      if (result.ok) {
        toast.success("Client deleted");
        router.push("/clients");
      } else {
        // Most often: the client has payment history and must be deactivated.
        toast.error(result.error);
      }
    });
  };

  return (
    <>
      <LinkButton href={`/clients/${client.id}/edit`} variant="secondary" size="sm">
        <Pencil className="size-4" />
        {t.common.edit}
      </LinkButton>
      <Button variant="secondary" size="sm" onClick={toggleStatus} disabled={pending}>
        <Power className="size-4" />
        {isActive ? t.client.deactivate : t.client.activate}
      </Button>
      <Button variant="ghost" size="sm" onClick={remove} disabled={pending} aria-label={t.common.delete}>
        <Trash2 className="size-4 text-danger" />
      </Button>
    </>
  );
}

/** Creates the missing bill for one client, straight from their page. */
export function GenerateClientBillButton({
  clientId,
  billingMonth,
}: {
  clientId: string;
  billingMonth: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  const generate = async () => {
    const confirmed = await confirm({
      title: t.bill.createOne,
      body: `Create the ${formatMonth(billingMonth)} bill for this client using their current monthly amount?`,
      confirmLabel: t.bill.createOne,
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await generateClientBillAction(clientId, billingMonth);
      if (result.ok) {
        toast.success(`${formatMonth(billingMonth)} bill created`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Button size="sm" onClick={generate} loading={pending}>
      <FilePlus2 className="size-4" />
      {t.bill.createOne}
    </Button>
  );
}

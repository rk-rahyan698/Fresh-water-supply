"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Pencil, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { deleteAreaAction, saveAreaAction } from "@/lib/actions/areas";
import { t } from "@/lib/i18n";
import type { Area } from "@/types/database";

const STATUS_OPTIONS = [
  { value: "true", label: t.area.active },
  { value: "false", label: t.area.inactive },
];

function AreaForm({
  area,
  open,
  onClose,
}: {
  area?: Area;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(undefined);
    setFieldErrors({});

    startTransition(async () => {
      const result = await saveAreaAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(t.area.saved);
        onClose();
        router.refresh();
      } else {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  };

  const formId = `area-form-${area?.id ?? "new"}`;

  return (
    <Modal
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={area ? t.area.edit : t.area.add}
      description={t.area.hint}
      size="sm"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={pending}
            fullWidth
            className="sm:w-auto"
          >
            {t.common.cancel}
          </Button>
          <Button type="submit" form={formId} loading={pending} fullWidth className="sm:w-auto">
            {pending ? t.common.saving : t.common.save}
          </Button>
        </div>
      }
    >
      <form id={formId} action={submit} className="space-y-4">
        <FormError>{error}</FormError>
        {area && <input type="hidden" name="id" value={area.id} />}
        <Input
          label={t.area.name}
          name="name"
          required
          autoFocus
          defaultValue={area?.name ?? ""}
          placeholder="e.g. Area 1"
          error={fieldErrors.name}
        />
        <Textarea
          label={t.area.description}
          name="description"
          hint={t.common.optional}
          rows={2}
          defaultValue={area?.description ?? ""}
          placeholder="Which part of town this covers"
        />
        <Select
          label={t.client.status}
          name="is_active"
          defaultValue={String(area?.is_active ?? true)}
          options={STATUS_OPTIONS}
          help="Inactive areas stay on existing clients but are hidden when assigning new ones."
        />
      </form>
    </Modal>
  );
}

export function AddAreaButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <MapPin className="size-4.5" />
        <span className="hidden sm:inline">{t.area.add}</span>
        <span className="sm:hidden">Add</span>
      </Button>
      {open && <AreaForm open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

export function EditAreaButton({ area }: { area: Area }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="size-4" />
        <span className="hidden sm:inline">{t.common.edit}</span>
      </Button>
      {open && <AreaForm area={area} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

export function DeleteAreaButton({ area, clientCount }: { area: Area; clientCount: number }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  const remove = async () => {
    const confirmed = await confirm({
      title: `${t.common.delete} ${area.name}`,
      body: t.area.deleteConfirm,
      confirmLabel: t.common.delete,
      tone: "danger",
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await deleteAreaAction(area.id);
      if (result.ok) {
        toast.success(t.area.deleted);
        router.refresh();
      } else {
        // Most often: the area still has clients, so it must be deactivated.
        toast.error(result.error);
      }
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={remove}
      disabled={pending || clientCount > 0}
      title={clientCount > 0 ? "Move its clients out first, or deactivate it" : t.common.delete}
      aria-label={t.common.delete}
    >
      <Trash2 className="size-4 text-danger" />
    </Button>
  );
}

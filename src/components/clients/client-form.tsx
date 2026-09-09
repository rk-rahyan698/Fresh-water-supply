"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Save } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormError, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { saveClientAction } from "@/lib/actions/clients";
import { dhakaToday, formatCurrency } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Area, ClientWithRate } from "@/types/database";

/** Mirrors clientSchema, minus the transforms - RHF works with raw strings. */
const formSchema = z.object({
  client_code: z
    .string()
    .trim()
    .min(1, "Client code is required")
    .max(24, "Keep the code under 24 characters")
    .regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers and dashes only"),
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  phone: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9+\-\s()]{6,}$/.test(v), "Enter a valid phone number"),
  address: z.string().trim().max(300, "Address is too long"),
  monthly_bill: z
    .string()
    .trim()
    .min(1, "Monthly bill is required")
    .refine((v) => {
      const n = Number(v.replace(/[,\s৳]/g, ""));
      return Number.isFinite(n) && n >= 0;
    }, "Enter a valid amount"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date"),
  area_id: z.string(),
  status: z.enum(["active", "inactive"]),
  notes: z.string().trim().max(1000, "Note is too long"),
});

type FormValues = z.infer<typeof formSchema>;

const STATUS_OPTIONS = [
  { value: "active", label: t.client.active },
  { value: "inactive", label: t.client.inactive },
];

export function ClientForm({
  client,
  suggestedCode,
  areas = [],
}: {
  client?: ClientWithRate;
  /** Pre-filled next code when creating, e.g. C-0007. */
  suggestedCode?: string;
  /** Active areas to choose from (spec section 19). */
  areas?: Pick<Area, "id" | "name">[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | undefined>();
  const isEdit = Boolean(client);

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      client_code: client?.client_code ?? suggestedCode ?? "",
      name: client?.name ?? "",
      phone: client?.phone ?? "",
      address: client?.address ?? "",
      monthly_bill: client ? String(client.monthly_bill) : "",
      start_date: client?.start_date ?? dhakaToday(),
      area_id: client?.area_id ?? "",
      status: client?.status ?? "active",
      notes: client?.notes ?? "",
    },
  });

  const monthlyBillRaw = useWatch({ control, name: "monthly_bill" });
  const monthlyBill = Number(String(monthlyBillRaw ?? "").replace(/[,\s৳]/g, ""));

  const onSubmit = handleSubmit((values) => {
    setFormError(undefined);

    const formData = new FormData();
    if (client) formData.set("id", client.id);
    formData.set("client_code", values.client_code);
    formData.set("name", values.name);
    formData.set("phone", values.phone);
    formData.set("address", values.address);
    formData.set("monthly_bill", values.monthly_bill);
    formData.set("start_date", values.start_date);
    formData.set("area_id", values.area_id);
    formData.set("status", values.status);
    formData.set("notes", values.notes);

    startTransition(async () => {
      const result = await saveClientAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(isEdit ? "Client updated" : "Client added");
        router.push(`/clients/${result.data.id}`);
        router.refresh();
        return;
      }

      // Surface server-side field errors (e.g. duplicate client code) inline.
      if (result.fieldErrors) {
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          if (field in formSchema.shape) {
            setError(field as keyof FormValues, { message });
          }
        }
      }
      setFormError(result.error);
    });
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError>{formError}</FormError>

      <Card>
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5">
          <Input
            label={t.client.name}
            required
            autoFocus={!isEdit}
            placeholder="e.g. Rahim Uddin"
            error={errors.name?.message}
            {...register("name")}
          />
          <Input
            label={t.client.code}
            required
            placeholder="C-0001"
            help="Must be unique. Used for quick search."
            error={errors.client_code?.message}
            {...register("client_code")}
          />
          <Input
            label={t.client.phone}
            type="tel"
            inputMode="tel"
            hint={t.common.optional}
            placeholder="01XXXXXXXXX"
            error={errors.phone?.message}
            {...register("phone")}
          />
          <Input
            label={t.client.startDate}
            type="date"
            required
            help="Bills are only generated from this month onwards."
            error={errors.start_date?.message}
            {...register("start_date")}
          />
          <Input
            label={t.client.address}
            hint={t.common.optional}
            placeholder="House, road, area"
            className="sm:col-span-2"
            error={errors.address?.message}
            {...register("address")}
          />
          <MoneyInput
            label={t.client.monthlyBill}
            required
            placeholder="1000"
            help={
              Number.isFinite(monthlyBill) && monthlyBill > 0
                ? `${formatCurrency(monthlyBill)} will be billed each month.`
                : "The amount billed to this client every month."
            }
            error={errors.monthly_bill?.message}
            {...register("monthly_bill")}
          />
          <Select
            label={t.area.one}
            options={[
              { value: "", label: t.area.none },
              ...areas.map((a) => ({ value: a.id, label: a.name })),
            ]}
            help={t.area.hint}
            error={errors.area_id?.message}
            {...register("area_id")}
          />
          <Select
            label={t.client.status}
            options={STATUS_OPTIONS}
            help="Inactive clients are skipped when generating bills."
            error={errors.status?.message}
            {...register("status")}
          />
          <Textarea
            label={t.client.notes}
            hint={t.common.optional}
            className="sm:col-span-2"
            placeholder="Anything worth remembering about this client"
            error={errors.notes?.message}
            {...register("notes")}
          />
        </div>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.back()}
          disabled={pending}
          fullWidth
          className="sm:w-auto"
        >
          {t.common.cancel}
        </Button>
        <Button type="submit" loading={pending} fullWidth className="sm:w-auto">
          <Save className="size-4" />
          {pending ? t.common.saving : isEdit ? t.common.save : t.client.add}
        </Button>
      </div>
    </form>
  );
}

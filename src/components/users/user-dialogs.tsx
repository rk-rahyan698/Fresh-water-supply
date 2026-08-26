"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Pencil, KeyRound } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  createUserAction,
  resetUserPasswordAction,
  updateUserAction,
} from "@/lib/actions/users";
import { t } from "@/lib/i18n";
import type { Profile } from "@/types/database";

const ROLE_OPTIONS = [
  { value: "collector", label: t.users.collector },
  { value: "admin", label: t.users.admin },
];

const STATUS_OPTIONS = [
  { value: "true", label: t.users.active },
  { value: "false", label: t.users.inactive },
];

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export function AddUserButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(undefined);
    setFieldErrors({});

    startTransition(async () => {
      const result = await createUserAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(t.users.created);
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UserPlus className="size-4.5" />
        <span className="hidden sm:inline">{t.users.add}</span>
        <span className="sm:hidden">Add</span>
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.users.add}
        description="Creates a sign-in account. Share the password with them directly."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={pending}
              fullWidth
              className="sm:w-auto"
            >
              {t.common.cancel}
            </Button>
            <Button
              type="submit"
              form="add-user-form"
              loading={pending}
              fullWidth
              className="sm:w-auto"
            >
              {pending ? t.common.saving : t.users.add}
            </Button>
          </div>
        }
      >
        <form id="add-user-form" action={submit} className="space-y-4">
          <FormError>{error}</FormError>
          <Input
            label={t.users.fullName}
            name="full_name"
            required
            autoFocus
            placeholder="e.g. Mama"
            error={fieldErrors.full_name}
          />
          <Input
            label={t.auth.email}
            name="email"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            required
            placeholder={t.auth.emailPlaceholder}
            error={fieldErrors.email}
          />
          <Input
            label={t.users.password}
            name="password"
            type="text"
            required
            help={t.users.passwordHint}
            error={fieldErrors.password}
          />
          <Input
            label={t.client.phone}
            name="phone"
            type="tel"
            inputMode="tel"
            hint={t.common.optional}
            error={fieldErrors.phone}
          />
          <Select
            label={t.users.role}
            name="role"
            defaultValue="collector"
            options={ROLE_OPTIONS}
            help="Admins see every screen. Collectors only see their own collections."
            error={fieldErrors.role}
          />
        </form>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                        */
/* -------------------------------------------------------------------------- */

export function EditUserButton({ user, isSelf }: { user: Profile; isSelf: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = async (formData: FormData) => {
    setError(undefined);

    // Deactivating someone locks them out - worth a confirmation.
    if (formData.get("is_active") === "false" && user.is_active) {
      const confirmed = await confirm({
        title: t.common.confirm,
        body: t.users.deactivateConfirm,
        confirmLabel: t.users.inactive,
        tone: "danger",
      });
      if (!confirmed) return;
    }

    startTransition(async () => {
      const result = await updateUserAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(t.users.updated);
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="size-4" />
        <span className="hidden sm:inline">{t.common.edit}</span>
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title={t.users.edit}
        description={user.email ?? undefined}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={pending}
              fullWidth
              className="sm:w-auto"
            >
              {t.common.cancel}
            </Button>
            <Button
              type="submit"
              form={`edit-user-${user.id}`}
              loading={pending}
              fullWidth
              className="sm:w-auto"
            >
              {pending ? t.common.saving : t.common.save}
            </Button>
          </div>
        }
      >
        <form id={`edit-user-${user.id}`} action={submit} className="space-y-4">
          <FormError>{error}</FormError>
          <input type="hidden" name="user_id" value={user.id} />
          <Input label={t.users.fullName} name="full_name" required defaultValue={user.full_name} />
          <Input
            label={t.client.phone}
            name="phone"
            type="tel"
            inputMode="tel"
            hint={t.common.optional}
            defaultValue={user.phone ?? ""}
          />
          <Select
            label={t.users.role}
            name="role"
            defaultValue={user.role}
            options={ROLE_OPTIONS}
            disabled={isSelf}
            help={isSelf ? "You cannot change your own role." : undefined}
          />
          <Select
            label={t.client.status}
            name="is_active"
            defaultValue={String(user.is_active)}
            options={STATUS_OPTIONS}
            disabled={isSelf}
            help={isSelf ? "You cannot deactivate yourself." : undefined}
          />
          {/* Disabled selects submit nothing, so send the current values. */}
          {isSelf && (
            <>
              <input type="hidden" name="role" value={user.role} />
              <input type="hidden" name="is_active" value={String(user.is_active)} />
            </>
          )}
        </form>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Reset password                                                              */
/* -------------------------------------------------------------------------- */

export function ResetPasswordButton({ user }: { user: Profile }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(undefined);

    startTransition(async () => {
      const result = await resetUserPasswordAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(`Password updated for ${user.full_name}`);
        setOpen(false);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Reset password"
        title="Reset password"
      >
        <KeyRound className="size-4" />
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : () => setOpen(false)}
        title="Reset password"
        description={`${user.full_name} · ${user.email ?? ""}`}
        size="sm"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={pending}
              fullWidth
              className="sm:w-auto"
            >
              {t.common.cancel}
            </Button>
            <Button
              type="submit"
              form={`reset-${user.id}`}
              loading={pending}
              fullWidth
              className="sm:w-auto"
            >
              {pending ? t.common.saving : t.common.save}
            </Button>
          </div>
        }
      >
        <form id={`reset-${user.id}`} action={submit} className="space-y-4">
          <FormError>{error}</FormError>
          <input type="hidden" name="user_id" value={user.id} />
          <Input
            label="New password"
            name="password"
            type="text"
            required
            autoFocus
            help={t.users.passwordHint}
          />
        </form>
      </Modal>
    </>
  );
}

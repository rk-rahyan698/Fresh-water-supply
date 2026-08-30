"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Pencil, KeyRound, Trash2, ShieldAlert } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormError, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  createUserAction,
  deleteUserAction,
  resetUserPasswordAction,
  updateUserAction,
} from "@/lib/actions/users";
import { cn } from "@/lib/cn";
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

          <div className="border-t border-line pt-4">
            <Input
              label="Your password"
              name="admin_password"
              type="password"
              autoComplete="current-password"
              required
              help="Confirm it is you before a new login is created."
              error={fieldErrors.admin_password}
            />
          </div>
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

  /**
   * Deliberately a plain onSubmit handler rather than React's `action` prop.
   *
   * A form `action` runs inside a transition, and awaiting the confirm dialog
   * from in there deadlocks: the dialog needs a state update to appear, that
   * update belongs to the same suspended transition, so the promise never
   * settles and Save hangs. preventDefault + an explicit startTransition keeps
   * the confirmation outside the transition, which is what every other dialog
   * in the app already does.
   */
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);

    const formData = new FormData(event.currentTarget);

    // Deactivating someone locks them out - worth a confirmation.
    if (formData.get("is_active") === "false" && user.is_active) {
      const confirmed = await confirm({
        title: t.users.deactivateConfirm,
        body: `${user.full_name} will no longer be able to sign in. Their collection history is kept.`,
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
        <form id={`edit-user-${user.id}`} onSubmit={submit} className="space-y-4" noValidate>
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

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Permanently deletes a user, gated on the admin's own password.
 *
 * Re-typing your password is what stops an unattended session from removing an
 * account; it is checked server-side by a real sign-in attempt.
 *
 * Accounts with financial history cannot be deleted at all; the server says
 * exactly what is in the way and points at deactivation instead.
 */
export function DeleteUserButton({ user, isSelf }: { user: Profile; isSelf: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const close = () => {
    setOpen(false);
    setPassword("");
    setError(undefined);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);

    if (password.length === 0) {
      setError("Enter your password to confirm.");
      return;
    }

    const formData = new FormData();
    formData.set("user_id", user.id);
    formData.set("admin_password", password);

    startTransition(async () => {
      const result = await deleteUserAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success(`${user.full_name} was deleted`);
        close();
        router.refresh();
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
        disabled={isSelf}
        aria-label={`Delete ${user.full_name}`}
        title={isSelf ? "You cannot delete your own account" : `Delete ${user.full_name}`}
      >
        <Trash2 className={cn("size-4", isSelf ? "text-ink-faint" : "text-danger")} />
      </Button>

      <Modal
        open={open}
        onClose={pending ? () => undefined : close}
        title="Delete user"
        description={`${user.full_name} · ${user.email ?? ""}`}
        size="sm"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={close}
              disabled={pending}
              fullWidth
              className="sm:w-auto"
            >
              {t.common.cancel}
            </Button>
            <Button
              type="submit"
              form={`delete-user-${user.id}`}
              variant="danger"
              loading={pending}
              fullWidth
              className="sm:w-auto"
            >
              <Trash2 className="size-4" />
              {pending ? "Deleting..." : "Delete permanently"}
            </Button>
          </div>
        }
      >
        <form id={`delete-user-${user.id}`} onSubmit={submit} className="space-y-4" noValidate>
          <FormError>{error}</FormError>

          <div className="flex gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3">
            <ShieldAlert className="mt-0.5 size-4.5 shrink-0 text-danger" />
            <p className="text-sm text-ink">
              This removes the sign-in account permanently and cannot be undone. A user who has
              collected payments, received cash or approved an adjustment{" "}
              <strong>cannot be deleted</strong> - set them to Inactive instead, so their name stays
              on the records they touched.
            </p>
          </div>

          <Input
            label="Your password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            autoFocus
            help={`Re-type your own admin password to confirm you meant to delete ${user.full_name}.`}
          />
        </form>
      </Modal>
    </>
  );
}

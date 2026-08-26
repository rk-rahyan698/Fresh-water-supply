"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { updateOwnProfileAction } from "@/lib/actions/users";
import { t } from "@/lib/i18n";
import type { Profile } from "@/types/database";

/**
 * Self-service profile edit.
 *
 * update_own_profile() deliberately cannot touch role or is_active, so a
 * collector cannot promote themselves by editing this form.
 */
export function ProfileForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(undefined);

    startTransition(async () => {
      const result = await updateOwnProfileAction(null, formData);
      if (!result) return;

      if (result.ok) {
        toast.success("Profile updated");
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form action={submit} className="space-y-4">
      <FormError>{error}</FormError>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t.users.fullName}
          name="full_name"
          required
          defaultValue={profile.full_name}
        />
        <Input
          label={t.client.phone}
          name="phone"
          type="tel"
          inputMode="tel"
          hint={t.common.optional}
          defaultValue={profile.phone ?? ""}
        />
        <Input
          label={t.auth.email}
          value={profile.email ?? ""}
          disabled
          readOnly
          help="Ask the owner to change your sign-in email."
        />
        <Input
          label={t.users.role}
          value={profile.role === "admin" ? t.users.admin : t.users.collector}
          disabled
          readOnly
        />
      </div>

      <Button type="submit" loading={pending}>
        <Save className="size-4" />
        {pending ? t.common.saving : t.common.save}
      </Button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signInAction } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { FormError, Input } from "@/components/ui/field";
import { t } from "@/lib/i18n";

function SubmitButton() {
  // useFormStatus reads the parent form's pending state, so the button
  // disables itself for the whole round trip.
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth loading={pending}>
      {pending ? t.auth.signingIn : t.auth.signIn}
    </Button>
  );
}

export function LoginForm({ next, initialError }: { next?: string; initialError?: string }) {
  const [state, formAction] = useActionState(signInAction, null);

  const error = state && !state.ok ? state.error : initialError;
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {next && <input type="hidden" name="next" value={next} />}

      <FormError>{error}</FormError>

      <Input
        label={t.auth.email}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        placeholder={t.auth.emailPlaceholder}
        required
        error={fieldErrors?.email}
      />

      <Input
        label={t.auth.password}
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder={t.auth.passwordPlaceholder}
        required
        error={fieldErrors?.password}
      />

      <SubmitButton />
    </form>
  );
}

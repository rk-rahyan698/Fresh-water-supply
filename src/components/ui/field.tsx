"use client";

import { forwardRef, useId } from "react";
import { cn } from "@/lib/cn";
import { CURRENCY_SYMBOL } from "@/lib/format";

const CONTROL =
  "block w-full rounded-xl border bg-white px-3.5 py-2.5 text-ink placeholder:text-ink-faint " +
  "transition-colors focus:outline-2 focus:outline-offset-0 focus:outline-brand-500 " +
  "disabled:bg-canvas disabled:text-ink-faint";

const CONTROL_OK = "border-line";
const CONTROL_BAD = "border-danger bg-danger-soft/40";

export function Label({
  htmlFor,
  children,
  hint,
  required,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
      {children}
      {required && <span className="ml-0.5 text-danger">*</span>}
      {hint && <span className="ml-1.5 font-normal text-ink-faint">({hint})</span>}
    </label>
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-1.5 text-sm text-danger">
      {children}
    </p>
  );
}

export function HelpText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-sm text-ink-soft">{children}</p>;
}

/* -------------------------------------------------------------------------- */

interface FieldWrapperProps {
  label?: React.ReactNode;
  error?: string;
  help?: React.ReactNode;
  required?: boolean;
  hint?: string;
  className?: string;
}

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    FieldWrapperProps {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, help, required, hint, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={inputId} required={required} hint={hint}>
          {label}
        </Label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className={cn(CONTROL, error ? CONTROL_BAD : CONTROL_OK)}
        {...props}
      />
      {error ? <FieldError>{error}</FieldError> : <HelpText>{help}</HelpText>}
    </div>
  );
});

/** Amount input with the taka sign inside the field and a numeric keypad. */
export const MoneyInput = forwardRef<HTMLInputElement, InputProps>(function MoneyInput(
  { label, error, help, required, hint, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={inputId} required={required} hint={hint}>
          {label}
        </Label>
      )}
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-lg text-ink-soft">
          {CURRENCY_SYMBOL}
        </span>
        <input
          ref={ref}
          id={inputId}
          type="text"
          // inputMode=decimal gives the phone keypad without the number-input quirks.
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          className={cn(
            CONTROL,
            error ? CONTROL_BAD : CONTROL_OK,
            "tnum pl-9 text-lg font-semibold tracking-tight",
          )}
          {...props}
        />
      </div>
      {error ? <FieldError>{error}</FieldError> : <HelpText>{help}</HelpText>}
    </div>
  );
});

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement>,
    FieldWrapperProps {
  options?: { value: string; label: string }[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, help, required, hint, className, id, options, children, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={selectId} required={required} hint={hint}>
          {label}
        </Label>
      )}
      <select
        ref={ref}
        id={selectId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, error ? CONTROL_BAD : CONTROL_OK, "appearance-none pr-9 bg-no-repeat")}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%23667' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
          backgroundPosition: "right 0.75rem center",
        }}
        {...props}
      >
        {options
          ? options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))
          : children}
      </select>
      {error ? <FieldError>{error}</FieldError> : <HelpText>{help}</HelpText>}
    </div>
  );
});

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    FieldWrapperProps {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, help, required, hint, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={textareaId} required={required} hint={hint}>
          {label}
        </Label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        rows={3}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, error ? CONTROL_BAD : CONTROL_OK, "resize-y")}
        {...props}
      />
      {error ? <FieldError>{error}</FieldError> : <HelpText>{help}</HelpText>}
    </div>
  );
});

/** Inline error banner for whole-form failures. */
export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-3 text-sm text-danger"
    >
      {children}
    </div>
  );
}

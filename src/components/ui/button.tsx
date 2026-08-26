import { forwardRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 focus-visible:outline-brand-600 shadow-sm",
  secondary:
    "bg-white text-ink border border-line hover:bg-canvas active:bg-brand-50 focus-visible:outline-brand-600",
  ghost: "bg-transparent text-ink-soft hover:bg-black/5 active:bg-black/10 focus-visible:outline-brand-600",
  danger:
    "bg-danger text-white hover:opacity-90 active:opacity-80 focus-visible:outline-danger shadow-sm",
  success:
    "bg-positive text-white hover:opacity-90 active:opacity-80 focus-visible:outline-positive shadow-sm",
};

/* Touch targets stay at/above 44px on mobile - collectors use this one-handed. */
const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-11 px-4 text-sm gap-2",
  lg: "h-13 px-6 text-base gap-2",
};

const BASE =
  "inline-flex items-center justify-center rounded-xl font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-55 select-none";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, fullWidth, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Disabling while loading is what stops a double-tap becoming two payments.
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...props}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

export interface LinkButtonProps extends React.ComponentProps<typeof Link> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

export function LinkButton({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <Link
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...props}
    >
      {children}
    </Link>
  );
}

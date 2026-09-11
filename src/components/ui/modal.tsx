"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Dialogs currently open, innermost last. Shared by every Modal on the page
 * because they stack: the confirm dialog opens on top of the collect-payment
 * dialog, and the two used to fight over the page.
 *
 * Scroll lock is a count, not a save/restore per dialog. Saving the old
 * `overflow` in each dialog broke as soon as two were open: when the confirm
 * closed in the same render the payment dialog re-rendered, the payment dialog
 * re-saved "hidden" as the value to restore, and on closing it put "hidden"
 * back - leaving the page unscrollable until a reload.
 */
const openStack: symbol[] = [];
let overflowBeforeLock = "";

function lockScroll(id: symbol) {
  if (openStack.length === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  openStack.push(id);
}

function unlockScroll(id: symbol) {
  const index = openStack.indexOf(id);
  if (index !== -1) openStack.splice(index, 1);
  if (openStack.length === 0) document.body.style.overflow = overflowBeforeLock;
}

const FIELD = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])";

/**
 * Bottom sheet on phones, centred dialog from `sm` up - the pattern collectors
 * already know from every other mobile app.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  // Callers pass a fresh onClose on every render. Read through an effect event
  // so the effect below runs on open and close only - not on every keystroke,
  // which used to pull focus out of the field being typed in.
  const close = useEffectEvent(() => onClose());

  useEffect(() => {
    if (!open) return;

    const id = Symbol("modal");
    lockScroll(id);

    const onKeyDown = (event: KeyboardEvent) => {
      // Only the dialog on top: Escape on a confirm must not also close the
      // form underneath it.
      if (event.key === "Escape" && openStack[openStack.length - 1] === id) close();
    };
    document.addEventListener("keydown", onKeyDown);

    // Move focus into the dialog for keyboard and screen-reader users, unless a
    // field already took it with autoFocus. The first form field, then the
    // first footer button (Cancel, on a confirm) - never the close button,
    // which comes first in the markup.
    const panel = panelRef.current;
    const returnFocusTo = document.activeElement as HTMLElement | null;
    if (!panel?.contains(returnFocusTo)) {
      const target =
        bodyRef.current?.querySelector<HTMLElement>(FIELD) ??
        footerRef.current?.querySelector<HTMLElement>("button:not([disabled])") ??
        bodyRef.current?.querySelector<HTMLElement>("button:not([disabled])");
      target?.focus();
    }

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlockScroll(id);
      // Back to where the user was - the Save button under a closing confirm.
      if (returnFocusTo?.isConnected && !panel?.contains(returnFocusTo)) {
        returnFocusTo.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-90 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/45 animate-[fade-in_150ms_ease-out]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={cn(
          "relative flex max-h-[92vh] w-full flex-col overflow-hidden bg-surface shadow-2xl",
          "rounded-t-2xl sm:rounded-2xl",
          "animate-[sheet-in_200ms_ease-out] sm:animate-[fade-in_150ms_ease-out]",
          size === "sm" && "sm:max-w-sm",
          size === "md" && "sm:max-w-md",
          size === "lg" && "sm:max-w-2xl",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-soft">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1.5 rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-black/5 hover:text-ink"
          >
            <X className="size-5" />
          </button>
        </div>

        <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {children}
        </div>

        {footer && (
          <div
            ref={footerRef}
            className="border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

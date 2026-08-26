"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Modal } from "./modal";
import { Button } from "./button";
import { t } from "@/lib/i18n";

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger" | "success";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based confirmations, so a caller reads as:
 *
 *   if (!(await confirm({ title: "Void this payment?" }))) return;
 *
 * Every financial action in the app goes through this (spec section 34).
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== null}
        onClose={() => settle(false)}
        title={options?.title ?? ""}
        size="sm"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => settle(false)} className="sm:w-auto" fullWidth>
              {options?.cancelLabel ?? t.common.cancel}
            </Button>
            <Button
              variant={options?.tone ?? "primary"}
              onClick={() => settle(true)}
              className="sm:w-auto"
              fullWidth
            >
              {options?.confirmLabel ?? t.common.confirm}
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-ink-soft">{options?.body}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return context;
}

import type { ReactNode, SelectHTMLAttributes } from "react";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { cn } from "@repo/ui/lib/utils";
import { ErrorState } from "./common.tsx";

/** A native select styled like Mira inputs; reliable for short option lists. */
export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn("relative inline-flex w-full", className)}>
      <select
        {...props}
        className="h-8 w-full appearance-none rounded-md border border-input bg-transparent py-1 pr-8 pl-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

/**
 * Confirmation for consequential actions. With `typed`, the user must type the
 * given text first (e.g. a project ID before deletion).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  typed,
  children,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly typed?: string;
  readonly children?: ReactNode;
  readonly onConfirm: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function confirm() {
    setBusy(true);
    setError(undefined);

    try {
      await onConfirm();
      setValue("");
      onOpenChange(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError(undefined);
          setValue("");
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {typed ? (
          <Field>
            <FieldLabel htmlFor="confirm-typed">
              Type <code className="font-mono">{typed}</code> to confirm
            </FieldLabel>
            <Input
              id="confirm-typed"
              autoComplete="off"
              className="font-mono"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        ) : null}
        {error === undefined ? null : <ErrorState error={error} />}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy || (typed !== undefined && value !== typed)}
            onClick={() => void confirm()}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tracks a single async action's busy/error state for inline buttons. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function run<A>(task: () => Promise<A>): Promise<A | undefined> {
    setBusy(true);
    setError(undefined);

    try {
      return await task();
    } catch (cause) {
      setError(cause);

      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run, clear: () => setError(undefined) };
}

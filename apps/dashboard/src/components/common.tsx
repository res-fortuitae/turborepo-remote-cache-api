import type { ReactNode } from "react";
import { useState } from "react";
import { AlertTriangle, Check, Copy, RotateCw } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import { Skeleton } from "@repo/ui/components/skeleton";
import { cn } from "@repo/ui/lib/utils";
import { errorMessage } from "../lib/api.ts";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? (
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CopyButton({
  text,
  label,
  className,
}: {
  readonly text: string;
  readonly label: string;
  readonly className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Button variant="outline" size="sm" onClick={copy} aria-label={label}>
        {status === "copied" ? (
          <Check data-icon="inline-start" />
        ) : (
          <Copy data-icon="inline-start" />
        )}
        {status === "copied" ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {status === "failed" ? "Copy unavailable. Select the text instead." : ""}
      </span>
    </span>
  );
}

export function CodeBlock({ code, label }: { readonly code: string; readonly label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <pre
        tabIndex={0}
        aria-label={label}
        className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <code>{code}</code>
      </pre>
      <CopyButton text={code} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
    >
      <span className="flex items-center gap-2 text-sm">
        <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        {errorMessage(error)}
      </span>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw data-icon="inline-start" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      {icon ? (
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      <h2 className="text-sm font-medium">{title}</h2>
      {description ? (
        <p className="max-w-sm text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

export function LoadingRows({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** Label/value pairs, e.g. for detail panels. */
export function DescriptionList({
  items,
}: {
  readonly items: ReadonlyArray<readonly [string, ReactNode]>;
}) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const formatDate = (value: string | number | Date | null | undefined) =>
  value === null || value === undefined
    ? "Never"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );

export const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

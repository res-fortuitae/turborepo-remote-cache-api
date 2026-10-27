import * as React from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/button";
import { FieldError, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";

type ClaimRow = { name: string; values: string };

function claimRowError(row: ClaimRow, reserved: string[] = []) {
  const name = row.name.trim();
  if (!name && !row.values.trim()) {
    return null;
  }
  if (!name) {
    return "Name the claim.";
  }
  if (reserved.includes(name)) {
    return "This claim has a dedicated field above.";
  }
  // Prototype-chain names silently vanish from plain-object claim maps.
  if (["__proto__", "constructor", "prototype"].includes(name)) {
    return "This claim name is not allowed.";
  }
  if (!/^[\w.-]+$/.test(name)) {
    return "Claim names: letters, digits, dots, dashes, underscores.";
  }
  if (!row.values.trim()) {
    return "Add at least one accepted value.";
  }
  return null;
}

function claimsListValid(rows: ClaimRow[], reserved: string[] = []) {
  return rows.every((row) => claimRowError(row, reserved) === null);
}

function splitValues(text: string) {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Compile side: fold rows into a claims map, never shadowing reserved names. */
function mergeClaimRows(claims: Record<string, string[]>, rows: ClaimRow[], reserved: string[]) {
  for (const row of rows) {
    const name = row.name.trim();
    const values = splitValues(row.values);
    if (!name || values.length === 0) {
      continue;
    }
    if (reserved.includes(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
      continue;
    }
    claims[name] = values;
  }
}

/**
 * Parse side: a row for every claim the form has no dedicated field for, or
 * null when rows cannot faithfully represent them (comma-bearing values,
 * names the row editor rejects) — recompiling would alter the policy.
 */
function claimRowsFromPolicy(claims: Record<string, string[]>, reserved: string[]) {
  const rows: ClaimRow[] = [];
  for (const [name, values] of Object.entries(claims)) {
    if (reserved.includes(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
      continue;
    }
    const row = { name, values: values.join(", ") };
    const split = splitValues(row.values);
    if (
      claimRowError(row) !== null ||
      split.length !== values.length ||
      split.some((value, index) => value !== values[index])
    ) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

function ClaimChip({ className, ...props }: React.ComponentProps<"code">) {
  return (
    <code
      data-slot="claim-chip"
      className={cn("ml-auto font-mono text-xs font-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

function ClaimsList({
  value,
  onChange,
  reserved = [],
  label = "Additional claims",
  className,
}: {
  value: ClaimRow[];
  onChange: (rows: ClaimRow[]) => void;
  /** Claims with dedicated fields — rows may not shadow them. */
  reserved?: string[];
  label?: string;
  className?: string;
}) {
  // Index keys would re-key the rows below a removal and drop focus. Replace
  // the value from outside by remounting (key the component).
  const [ids, setIds] = React.useState<string[]>(() => value.map((_, index) => `seed-${index}`));
  const counterRef = React.useRef(0);

  const update = (index: number, patch: Partial<ClaimRow>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const remove = (index: number) => {
    setIds(ids.filter((_, i) => i !== index));
    onChange(value.filter((_, i) => i !== index));
  };

  const add = () => {
    setIds([...ids, `row-${counterRef.current++}`]);
    onChange([...value, { name: "", values: "" }]);
  };

  return (
    <div data-slot="claims-list" className={cn("flex flex-col gap-2", className)}>
      <FieldLabel>{label}</FieldLabel>
      {value.map((row, index) => {
        const rowError = claimRowError(row, reserved);
        return (
          <div key={ids[index] ?? index} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                value={row.name}
                placeholder="claim"
                aria-label="Claim name"
                className="w-40 shrink-0 font-mono text-xs"
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <Input
                value={row.values}
                placeholder="value1, value2"
                aria-label="Accepted values"
                className="font-mono text-xs"
                onChange={(event) => update(index, { values: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove claim"
                onClick={() => remove(index)}
              >
                <Trash2Icon />
              </Button>
            </div>
            {rowError ? <FieldError>{rowError}</FieldError> : null}
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={add}>
        <PlusIcon data-icon="inline-start" />
        Add claim
      </Button>
    </div>
  );
}

export {
  ClaimsList,
  ClaimChip,
  claimRowError,
  claimsListValid,
  mergeClaimRows,
  claimRowsFromPolicy,
};
export type { ClaimRow };

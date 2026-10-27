import { AuditPage, type AuditEvent } from "@repo/shared";
import { api } from "./api.ts";

export interface AuditFilter {
  readonly from: string;
  readonly to: string;
  readonly actor?: string;
  readonly action?: string;
  readonly target?: string;
  readonly outcome?: "allow" | "deny" | "error" | "";
}
export const auditPath = (orgId?: string) =>
  orgId ? `/orgs/${encodeURIComponent(orgId)}/audit` : "/instance/audit";
export function auditParams(filter: AuditFilter) {
  const params = new URLSearchParams({ from: filter.from, to: filter.to });
  for (const name of ["actor", "action", "target", "outcome"] as const) {
    if (filter[name]?.trim()) params.set(name, filter[name]!.trim());
  }
  return params;
}
export const readAudit = (
  orgId: string | undefined,
  filter: AuditFilter,
  cursor?: string,
  signal?: AbortSignal,
) => {
  const params = auditParams(filter);
  params.set("limit", "100");
  if (cursor) params.set("cursor", cursor);
  return api(`${auditPath(orgId)}?${params}`, { schema: AuditPage, signal });
};
export const auditExport = (
  orgId: string | undefined,
  filter: AuditFilter,
  format: "csv" | "jsonl",
) => `${auditPath(orgId)}/export.${format}?${auditParams(filter)}`;

/** Late Basin delivery and refreshes may repeat events. Keep identity stable and newest first. */
export const mergeAudit = (
  existing: ReadonlyArray<AuditEvent>,
  incoming: ReadonlyArray<AuditEvent>,
) =>
  [...new Map([...existing, ...incoming].map((event) => [event.id, event])).values()].sort(
    (a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id),
  );
export const searchAudit = (events: ReadonlyArray<AuditEvent>, query: string) => {
  const needle = query.trim().toLowerCase();
  return needle
    ? events.filter((event) => JSON.stringify(event).toLowerCase().includes(needle))
    : events;
};

/** Catch up through bursts rather than silently skipping everything after page one. */
export async function tailAudit(
  orgId: string | undefined,
  filter: AuditFilter,
  knownIds: ReadonlySet<string>,
  signal?: AbortSignal,
) {
  const items: AuditEvent[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await readAudit(orgId, filter, cursor, signal);
    items.push(...page.items);
    if (
      !page.nextCursor ||
      knownIds.size === 0 ||
      page.items.some((event) => knownIds.has(event.id))
    )
      return items;
    cursor = page.nextCursor;
  }
  throw new Error(
    "Live tail exceeds 1,000 events between updates. Narrow the filters or use export to retrieve the full interval.",
  );
}

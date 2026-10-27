import { afterEach, expect, test } from "bun:test";
import type { AuditEvent } from "@repo/shared";
import { auditExport, auditParams, mergeAudit, readAudit, searchAudit } from "./audit.ts";

const filter = {
  from: "2026-10-20T00:00:00.000Z",
  to: "2026-10-27T00:00:00.000Z",
  actor: "alice",
  outcome: "deny" as const,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const event = (id: string, ts: string): AuditEvent => ({
  id,
  ts,
  schemaVersion: 1,
  scope: "org",
  orgId: "org",
  actor: { id: "alice", display: "Alice", type: "user" },
  action: "oidc.exchange",
  target: { type: "project", id: "p" },
  outcome: "deny",
  reason: "claims_mismatch",
  ip: "127.0.0.1",
  userAgent: "test",
  requestId: "req",
  metadata: { claims: { repository: "acme/web" } },
  prevHash: null,
  hash: "hash",
});

test("exports preserve filters without pagination parameters", () => {
  const url = new URL(auditExport("org", filter, "jsonl"), "https://example.test");
  expect(url.pathname).toBe("/orgs/org/audit/export.jsonl");
  expect(url.searchParams.get("actor")).toBe("alice");
  expect(url.searchParams.get("outcome")).toBe("deny");
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(url.searchParams.has("limit")).toBe(false);
  expect(auditParams({ ...filter, action: "" }).has("action")).toBe(false);
});

test("page reads preserve exact range and opaque cursor", async () => {
  let url: URL | undefined;
  globalThis.fetch = (async (input) => {
    url = new URL(String(input), "https://example.test");
    return Response.json({ items: [], nextCursor: null });
  }) as typeof fetch;
  await readAudit("org", filter, "opaque+/=");
  expect(url?.searchParams.get("cursor")).toBe("opaque+/=");
  expect(url?.searchParams.get("from")).toBe(filter.from);
  expect(url?.searchParams.get("to")).toBe(filter.to);
});

test("live tail merges late duplicates by ID and sorts newest first", () => {
  const old = event("01AAAAAAAAAAAAAAAAAAAAAAAA", filter.from);
  const recent = event("01BBBBBBBBBBBBBBBBBBBBBBBB", filter.to);
  expect(mergeAudit([old], [recent, old])).toEqual([recent, old]);
  expect(searchAudit([old, recent], "ACME/WEB")).toHaveLength(2);
  expect(searchAudit([old], "claims_mismatch")).toHaveLength(1);
  expect(searchAudit([old], "missing")).toHaveLength(0);
});

test("live tail catches up across pages with the same query window", async () => {
  const { tailAudit } = await import("./audit.ts");
  const recent = event("01BBBBBBBBBBBBBBBBBBBBBBBB", filter.to);
  const known = event("01AAAAAAAAAAAAAAAAAAAAAAAA", filter.from);
  const requests: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), "https://example.test");
    requests.push(url);
    return Response.json(
      url.searchParams.has("cursor")
        ? { items: [known], nextCursor: null }
        : { items: [recent], nextCursor: "next" },
    );
  }) as typeof fetch;
  expect(await tailAudit("org", filter, new Set([known.id]))).toEqual([recent, known]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.searchParams.get("cursor")).toBe("next");
  expect(requests[1]?.searchParams.get("to")).toBe(filter.to);
});

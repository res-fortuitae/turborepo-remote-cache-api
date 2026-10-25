import { describe, expect, test } from "bun:test";
import type { Target } from "./target.ts";

/**
 * Who presents the request. Later milestones add principals (scoped cache
 * tokens, OIDC identities, dashboard roles) as new variants plus rows.
 */
export type Principal = "anonymous" | "malformed" | "invalid" | "admin";

export interface Operation {
  readonly name: string;
  readonly method: string;
  readonly path: (team: string) => string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface PermissionRow {
  readonly principal: Principal;
  readonly operation: Operation;
  readonly status: number;
}

const json = { "Content-Type": "application/json" };

export const operations = {
  status: { name: "read status", method: "GET", path: (t) => `/v8/artifacts/status?teamId=${t}` },
  head: { name: "check artifact", method: "HEAD", path: (t) => `/v8/artifacts/abc123?teamId=${t}` },
  download: {
    name: "download artifact",
    method: "GET",
    path: (t) => `/v8/artifacts/abc123?teamId=${t}`,
  },
  upload: {
    name: "upload artifact",
    method: "PUT",
    path: (t) => `/v8/artifacts/abc123?teamId=${t}`,
    headers: { "Content-Type": "application/octet-stream" },
    body: "matrix artifact",
  },
  query: {
    name: "query artifacts",
    method: "POST",
    path: (t) => `/v8/artifacts?teamId=${t}`,
    headers: json,
    body: JSON.stringify({ hashes: ["abc123"] }),
  },
  events: {
    name: "record events",
    method: "POST",
    path: (t) => `/v8/artifacts/events?teamId=${t}`,
    headers: json,
    body: JSON.stringify([{ sessionId: "matrix", source: "LOCAL", event: "MISS", hash: "abc123" }]),
  },
} satisfies Record<string, Operation>;

const credentials: Record<Exclude<Principal, "admin">, string | undefined> = {
  anonymous: undefined,
  malformed: "Basic Zm9vOmJhcg==",
  invalid: "Bearer not-the-token",
};

const denied = { anonymous: 401, malformed: 401, invalid: 401 } as const;

/**
 * Expected status for every principal × operation. The single `admin` token
 * may do everything; unauthenticated principals are always rejected before
 * the artifact store is touched. Rows run in order, so `admin` uploads the
 * artifact before reading it back.
 */
export const permissionMatrix: readonly PermissionRow[] = [
  ...(["anonymous", "malformed", "invalid"] as const).flatMap((principal) =>
    Object.values(operations).map((operation) => ({
      principal,
      operation,
      status: denied[principal],
    })),
  ),
  { principal: "admin", operation: operations.status, status: 200 },
  { principal: "admin", operation: operations.download, status: 404 },
  { principal: "admin", operation: operations.upload, status: 202 },
  { principal: "admin", operation: operations.head, status: 200 },
  { principal: "admin", operation: operations.download, status: 200 },
  { principal: "admin", operation: operations.query, status: 200 },
  { principal: "admin", operation: operations.events, status: 200 },
];

const authorization = (principal: Principal, token: string) =>
  principal === "admin" ? `Bearer ${token}` : credentials[principal];

export const describePermissionMatrix = (
  target: () => Target,
  team: string,
  rows: readonly PermissionRow[] = permissionMatrix,
) =>
  describe("permission matrix", () => {
    for (const { principal, operation, status } of rows) {
      test(`${principal} ${operation.name} -> ${status}`, async () => {
        const { fetch, token } = target();
        const headers = new Headers(operation.headers);
        const value = authorization(principal, token);

        if (value !== undefined) headers.set("Authorization", value);

        const response = await fetch(operation.path(team), {
          method: operation.method,
          headers,
          body: operation.body,
        });

        await response.body?.cancel();
        expect(response.status).toBe(status);
      });
    }
  });

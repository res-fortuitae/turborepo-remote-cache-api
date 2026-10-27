/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Tests the external HTTP boundary. */
import { expect, test } from "bun:test";
import { AuditHistory, validateAuditSelection } from "@repo/audit";
import { Effect, Redacted } from "effect";
import { basinAuditHistory } from "../src/audit-history.ts";

const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
const event = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ts: "2026-02-01T00:00:00.000Z",
  schemaVersion: 1,
  scope: "org",
  orgId: "org-a",
  projectId: null,
  actor: { type: "user", id: "actor", display: "Actor" },
  action: "project.created",
  target: { type: "project", id: "project" },
  outcome: "allow",
  reason: null,
  ip: "",
  userAgent: "",
  requestId: "request",
  metadata: {},
  prevHash: null,
  hash: "hash",
};

test("Basin HTTP uses the read credential, fixed endpoint and scoped SQL, and normalizes optional nulls", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { selection } = yield* validateAuditSelection("org-a", range);
      const history = yield* AuditHistory;
      const rows = yield* history.read(selection, 51);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBe("org-a");
      expect(rows[0]?.projectId).toBeUndefined();
    }).pipe(
      Effect.provide(
        basinAuditHistory(
          "a".repeat(32),
          "audit-catalog",
          Redacted.make("read-only-token"),
          async (url, init) => {
            expect(String(url)).toBe(
              `https://api.sql.cloudflarestorage.com/api/v1/accounts/${"a".repeat(32)}/basin-sql/query/audit-catalog`,
            );
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer read-only-token");
            const body = JSON.parse(String(init?.body));
            expect(body.query).toContain("\"orgId\" = 'org-a'");
            expect(body.query).toContain("LIMIT 51");
            return globalThis.Response.json({ success: true, result: { rows: [event] } });
          },
        ),
      ),
    ),
  ));

test("Basin errors are sanitized and never become empty successful history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { selection } = yield* validateAuditSelection("org-a", range);
      const history = yield* AuditHistory;
      const result = yield* Effect.result(history.read(selection, 51));
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).not.toContain("private-token");
    }).pipe(
      Effect.provide(
        basinAuditHistory(
          "a".repeat(32),
          "audit-catalog",
          Redacted.make("private-token"),
          async () => new globalThis.Response("private-token", { status: 403 }),
        ),
      ),
    ),
  ));

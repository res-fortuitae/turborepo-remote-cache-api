import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { ArtifactOperationRecord, CacheEventRecord } from "./analytics-events.ts";

const scope = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ts: "2026-10-27T00:00:00.000Z",
  day: "2026-10-27",
  schemaVersion: 1,
  org_id: "org-1",
  project_id: "project-1",
  credential_type: "jwt",
  ci_provider: "github",
  sample_rate: 1,
} as const;

const cache = {
  ...scope,
  session_id: "s",
  source: "REMOTE",
  event: "HIT",
  hash: "abc",
  duration_ms: 12,
  repo_id: null,
  ref: null,
} as const;

const artifact = {
  ...scope,
  operation: "QUERY",
  op: "query",
  hash: "",
  status: 200,
  bytes: 0,
  latency_ms: 1.5,
  edge_cache: "BYPASS",
  colo: null,
  credential_id: null,
  client_ci: null,
  interactive: false,
} as const;

describe("versioned analytics records", () => {
  test("accepts nullable enrichment and query operations", () => {
    expect(Schema.decodeUnknownSync(CacheEventRecord)(cache)).toEqual(cache);
    expect(Schema.decodeUnknownSync(ArtifactOperationRecord)(artifact)).toEqual(artifact);
  });
  test("rejects invalid versions, identities, timestamps and sampling", () => {
    for (const patch of [
      { schemaVersion: 2 },
      { event_id: "uuid" },
      { org_id: "" },
      { ts: "2026-02-30T00:00:00Z" },
      { sample_rate: 0 },
      { sample_rate: 1.1 },
      { duration_ms: -1 },
      { duration_ms: 1.5 },
    ]) {
      expect(() => Schema.decodeUnknownSync(CacheEventRecord)({ ...cache, ...patch })).toThrow();
    }

    for (const patch of [{ status: 600 }, { bytes: -1 }, { latency_ms: Infinity }]) {
      expect(() =>
        Schema.decodeUnknownSync(ArtifactOperationRecord)({ ...artifact, ...patch }),
      ).toThrow();
    }
  });
  test("drops unapproved personal fields at the serialization boundary", () => {
    expect(
      Schema.decodeUnknownSync(CacheEventRecord)({
        ...cache,
        email: "private@example.com",
        name: "private",
      }),
    ).toEqual(cache);
  });
});

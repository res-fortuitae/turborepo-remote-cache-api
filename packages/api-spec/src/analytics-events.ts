import * as Schema from "effect/Schema";
import { Id, Timestamp, Ulid } from "./common.ts";

const Scope = {
  id: Ulid,
  ts: Timestamp,
  schemaVersion: Schema.Literal(1),
  org_id: Id,
  project_id: Id,
  ci_provider: Schema.String,
};

/** Server-enriched stream records, distinct from the untrusted Turbo wire payload. */
export const CacheEventRecord = Schema.Struct({
  ...Scope,
  session_id: Schema.String,
  source: Schema.Literals(["LOCAL", "REMOTE"]),
  event: Schema.Literals(["HIT", "MISS"]),
  hash: Schema.String,
  duration_ms: Schema.Number,
});

export const ArtifactOperationRecord = Schema.Struct({
  ...Scope,
  operation: Schema.Literals(["GET", "HEAD", "PUT", "DELETE"]),
  hash: Schema.String,
  status: Schema.Number,
  bytes: Schema.Number,
  edge_cache: Schema.Literals(["HIT", "MISS", "BYPASS"]),
});

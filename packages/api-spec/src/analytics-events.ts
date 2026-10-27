import * as Schema from "effect/Schema";
import { Id, NonNegativeInteger, Timestamp, Ulid } from "./common.ts";

const NullableId = Schema.NullOr(Id);
const Scope = {
  // Keep the original stream columns: Iceberg evolution is additive only.
  id: Ulid,
  event_id: Ulid,
  ts: Timestamp,
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  schemaVersion: Schema.Literal(1),
  org_id: Id,
  project_id: Id,
  credential_type: Schema.Literals(["jwt", "apiKey", "legacy"]),
  ci_provider: Schema.String,
  sample_rate: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
};

/** Server-enriched records. Never copy arbitrary claims or request headers into these records. */
export const CacheEventRecord = Schema.Struct({
  ...Scope,
  session_id: Schema.String,
  source: Schema.Literals(["LOCAL", "REMOTE"]),
  event: Schema.Literals(["HIT", "MISS"]),
  hash: Schema.String,
  duration_ms: NonNegativeInteger,
  repo_id: NullableId,
  ref: Schema.NullOr(Schema.String),
});
export type CacheEventRecord = typeof CacheEventRecord.Type;

export const ArtifactOperationRecord = Schema.Struct({
  ...Scope,
  operation: Schema.Literals(["GET", "HEAD", "PUT", "DELETE", "QUERY"]),
  op: Schema.Literals(["get", "head", "put", "delete", "query"]),
  hash: Schema.String,
  status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
  bytes: NonNegativeInteger,
  latency_ms: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite()),
  edge_cache: Schema.Literals(["HIT", "MISS", "BYPASS"]),
  colo: Schema.NullOr(Schema.String),
  credential_id: NullableId,
  client_ci: Schema.NullOr(Schema.String),
  interactive: Schema.Boolean,
});
export type ArtifactOperationRecord = typeof ArtifactOperationRecord.Type;

import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Id, PaginationQuery, TimeRangeQuery, Timestamp, Ulid } from "./common.ts";
import { ApiErrors } from "./http-errors.ts";
import { ApiAuthorization } from "./authorization.ts";

export const AuditActor = Schema.Struct({
  type: Schema.Literals(["user", "apiKey", "oidc", "system", "instanceAdmin"]),
  id: Id,
  display: Schema.String,
});

export const AuditTarget = Schema.Struct({ type: Schema.NonEmptyString, id: Id });
export const AuditOutcome = Schema.Literals(["allow", "deny", "error"]);

export const AuditEvent = Schema.Struct({
  id: Ulid,
  ts: Timestamp,
  schemaVersion: Schema.Literal(1),
  scope: Schema.Literals(["instance", "org"]),
  orgId: Schema.optional(Id),
  projectId: Schema.optional(Id),
  actor: AuditActor,
  action: Schema.NonEmptyString,
  target: AuditTarget,
  outcome: AuditOutcome,
  reason: Schema.optional(Schema.String),
  ip: Schema.String,
  userAgent: Schema.String,
  requestId: Id,
  // Callers must redact secrets before creating metadata. Schemas cannot infer secrets.
  metadata: Schema.JsonObject,
  prevHash: Schema.NullOr(Schema.String),
  hash: Schema.String,
});

export const AuditFilters = Schema.Struct({
  ...TimeRangeQuery.fields,
  actor: Schema.optional(Id),
  action: Schema.optional(Schema.NonEmptyString),
  target: Schema.optional(Id),
  outcome: Schema.optional(AuditOutcome),
});

export const AuditQuery = Schema.Struct({ ...AuditFilters.fields, ...PaginationQuery.fields });

export const AuditPage = Schema.Struct({
  items: Schema.Array(AuditEvent),
  nextCursor: Schema.NullOr(Schema.String),
});

export const AuditCsv = HttpApiSchema.StreamUint8Array({ contentType: "text/csv" });
export const AuditJsonl = HttpApiSchema.StreamNdjson({ schema: AuditEvent });

export const AuditApi = HttpApiGroup.make("audit")
  .add(
    HttpApiEndpoint.get("org", "/orgs/:id/audit", {
      params: { id: Id },
      query: AuditQuery,
      success: AuditPage,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("instance", "/instance/audit", {
      query: AuditQuery,
      success: AuditPage,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("exportOrg", "/orgs/:id/audit/export.csv", {
      params: { id: Id },
      query: AuditFilters,
      success: AuditCsv,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("exportOrgJsonl", "/orgs/:id/audit/export.jsonl", {
      params: { id: Id },
      query: AuditFilters,
      success: AuditJsonl,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("exportInstanceJsonl", "/instance/audit/export.jsonl", {
      query: AuditFilters,
      success: AuditJsonl,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("exportInstance", "/instance/audit/export.csv", {
      query: AuditFilters,
      success: AuditCsv,
      error: ApiErrors,
    }),
  )
  .middleware(ApiAuthorization);

export type AuditEvent = typeof AuditEvent.Type;

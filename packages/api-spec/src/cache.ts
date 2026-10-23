import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

// These payload schemas intentionally preserve the existing Turbo wire contract.
// Query hashes are not refined: invalid hashes have per-entry errors.
export const ArtifactQueryRequest = Schema.Struct({ hashes: Schema.Array(Schema.String) });

export const CacheEvent = Schema.Struct({
  sessionId: Schema.String,
  source: Schema.Literals(["LOCAL", "REMOTE"]),
  event: Schema.Literals(["HIT", "MISS"]),
  hash: Schema.String,
  duration: Schema.optional(Schema.Number),
});

export const CacheEvents = Schema.Array(CacheEvent);

export const CacheStatus = Schema.Struct({
  status: Schema.Literals(["disabled", "enabled", "over_limit", "paused"]),
});

export const ArtifactQueryMetadata = Schema.Struct({
  size: Schema.Number,
  taskDurationMs: Schema.Number,
  tag: Schema.optional(Schema.String),
});

export const ArtifactQueryResponse = Schema.Record(
  Schema.String,
  Schema.Union([
    ArtifactQueryMetadata,
    Schema.Null,
    Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
  ]),
);

export const ArtifactUploadResponse = Schema.Struct({ urls: Schema.Array(Schema.String) });

export const ArtifactParams = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]+$/)),
});

export const CacheQuery = Schema.Struct({
  teamId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

export const ArtifactHeaders = Schema.Struct({
  "content-length": Schema.String,
  "x-artifact-duration": Schema.optional(Schema.String),
  "x-artifact-tag": Schema.optional(Schema.String),
  "x-artifact-sha": Schema.optional(Schema.String),
  "x-artifact-dirty-hash": Schema.optional(Schema.String),
});

export const ArtifactUploadHeaders = Schema.Struct({
  ...ArtifactHeaders.fields,
  "x-artifact-client-ci": Schema.optional(Schema.String),
});

export const ArtifactDownloadHeaders = Schema.Struct({
  ...ArtifactHeaders.fields,
  "x-edge-cache": Schema.optional(Schema.Literals(["HIT", "MISS"])),
});

export const ArtifactBody = HttpApiSchema.StreamUint8Array();

// Turbo errors have no _tag on the wire. Keep them distinct from platform errors.
export const CacheError = Schema.Struct({ code: Schema.String, message: Schema.String });
const errorStatuses = [400, 401, 403, 404, 405, 429, 500];

const errors = errorStatuses.map((code) => CacheError.pipe(HttpApiSchema.status(code)));

export const CacheApi = HttpApiGroup.make("cache").add(
  HttpApiEndpoint.get("status", "/v8/artifacts/status", {
    query: CacheQuery,
    success: CacheStatus,
    error: errors,
  }),
  HttpApiEndpoint.post("query", "/v8/artifacts", {
    query: CacheQuery,
    payload: ArtifactQueryRequest,
    success: ArtifactQueryResponse,
    error: errors,
  }),
  HttpApiEndpoint.post("events", "/v8/artifacts/events", {
    query: CacheQuery,
    payload: CacheEvents,
    success: HttpApiSchema.Empty(200),
    error: errors,
  }),
  HttpApiEndpoint.head("head", "/v8/artifacts/:hash", {
    params: ArtifactParams,
    query: CacheQuery,
    success: HttpApiSchema.WithHeaders(HttpApiSchema.Empty(200), ArtifactHeaders),
    error: errorStatuses.map((code) => HttpApiSchema.Empty(code)),
  }),
  HttpApiEndpoint.get("download", "/v8/artifacts/:hash", {
    params: ArtifactParams,
    query: CacheQuery,
    success: HttpApiSchema.WithHeaders(ArtifactBody, ArtifactDownloadHeaders),
    error: errors,
  }),
  HttpApiEndpoint.put("upload", "/v8/artifacts/:hash", {
    params: ArtifactParams,
    query: CacheQuery,
    headers: ArtifactUploadHeaders,
    payload: ArtifactBody,
    success: ArtifactUploadResponse.pipe(HttpApiSchema.status(202)),
    error: errors,
  }),
);

export type CacheEvent = typeof CacheEvent.Type;

export type ArtifactQueryRequest = typeof ArtifactQueryRequest.Type;

export type ArtifactQueryResponse = typeof ArtifactQueryResponse.Type;

import * as Schema from "effect/Schema";

export const ArtifactQueryRequest = Schema.Struct({
  hashes: Schema.Array(Schema.String),
});

export const CacheEvent = Schema.Struct({
  sessionId: Schema.String,
  source: Schema.Literals(["LOCAL", "REMOTE"]),
  event: Schema.Literals(["HIT", "MISS"]),
  hash: Schema.String,
  duration: Schema.optional(Schema.Number),
});

export const CacheEvents = Schema.Array(CacheEvent);

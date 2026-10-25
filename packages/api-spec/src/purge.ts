import { Schema } from "effect";
const value = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const PurgeFilter = Schema.Struct({
  hash: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]+$/), Schema.isMaxLength(256)),
  ),
  credentialId: Schema.optional(value),
  userId: Schema.optional(value),
  provider: Schema.optional(value),
  repositoryId: Schema.optional(value),
  ref: Schema.optional(value),
  jobWorkflowRef: Schema.optional(value),
  runId: Schema.optional(value),
  commitSha: Schema.optional(value),
  since: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
});
export type PurgeFilter = typeof PurgeFilter.Type;

export const PurgeReport = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["scanning", "ready", "queued", "complete", "too_large"]),
  count: Schema.Number,
  bytes: Schema.Number,
  removed: Schema.Number,
  removedBytes: Schema.Number,
});
export type PurgeReport = typeof PurgeReport.Type;

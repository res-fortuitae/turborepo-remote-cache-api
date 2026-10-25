import * as Schema from "effect/Schema";

export const Capability = Schema.Struct({
  enabled: Schema.Boolean,
  reason: Schema.String,
  fallback: Schema.String,
  upgrade: Schema.String,
});

/** Public, non-secret deployment facts shared by the console and doctor. */
export const CapabilityReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workersPlan: Schema.Literals(["free", "paid", "unknown", "local"]),
  zonePlan: Schema.Literals(["free", "pro", "business", "enterprise", "unknown", "none"]),
  emailSending: Capability,
  analytics: Capability,
  auditHistory: Capability,
  directUploads: Capability,
  analyticsMode: Schema.Literals(["lite", "disabled"]),
  auditRetentionDays: Schema.Number,
  warnings: Schema.Array(Schema.String),
});

export type CapabilityReport = typeof CapabilityReport.Type;

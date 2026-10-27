import * as Schema from "effect/Schema";
const Status = Schema.Literals(["ok", "error"]);
export const HealthReport = Schema.Struct({
  version: Schema.String,
  schema_version: Schema.Int,
  healthy: Schema.Boolean,
  checks: Schema.Struct({ d1: Status, r2: Status, kv: Status, coordinator: Status }),
  capabilities: Schema.Struct({
    analytics: Schema.Boolean,
    auditHistory: Schema.Boolean,
    directUploads: Schema.Boolean,
    emailSending: Schema.Boolean,
  }),
});
export const SelfTestReport = Schema.Struct({
  ok: Schema.Boolean,
  requestId: Schema.String,
  auth: Schema.Struct({ github: Schema.Boolean, orgCreation: Schema.String }),
  steps: Schema.Array(
    Schema.Struct({ name: Schema.String, ok: Schema.Boolean, latencyMs: Schema.Number }),
  ),
});

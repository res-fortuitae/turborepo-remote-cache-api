import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** Placeholder entry; STV-457 replaces it with the api-spec event schema. */
export const AuditEntry = Schema.Struct({
  action: Schema.String,
  actorId: Schema.optional(Schema.String),
  targetId: Schema.optional(Schema.String),
});

export type AuditEntry = typeof AuditEntry.Type;

export class AuditLogError extends Schema.TaggedError<AuditLogError>()("AuditLogError", {
  cause: Schema.Unknown,
}) {}

export interface AuditLogService {
  readonly record: (entry: AuditEntry) => Effect.Effect<void, AuditLogError>;
}

export class AuditLog extends Context.Service<AuditLog, AuditLogService>()(
  "@repo/audit/AuditLog",
) {}

/** Discards entries. Stands in until STV-457 adds the transactional outbox. */
export const AuditLogNoop: Layer.Layer<AuditLog> = Layer.succeed(AuditLog, {
  record: () => Effect.void,
});

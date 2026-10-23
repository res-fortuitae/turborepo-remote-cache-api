import * as Layer from "effect/Layer";
import { AuditLogLive, AuditSinkTest } from "./audit-log.ts";

/**
 * `AuditLogLive` writing to the provided `Database`, with an in-memory sink.
 * Read exported events from `AuditSinkMemory` after `drainOutbox`.
 */
export const AuditLogTest = AuditLogLive.pipe(Layer.provideMerge(AuditSinkTest));

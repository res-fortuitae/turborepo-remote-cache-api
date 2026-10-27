import { ArtifactOperationRecord, CacheEventRecord } from "@repo/api-spec";
import { Clock, Context, Effect, Layer, Metric, Schema } from "effect";
import {
  AnalyticsEmitter,
  AnalyticsError,
  ArtifactOpEmitter,
  type AnalyticsScope,
  type ArtifactOperation,
} from "./emitter.ts";

export class CacheEventsStream extends Context.Service<
  CacheEventsStream,
  {
    readonly send: (events: readonly CacheEventRecord[]) => Effect.Effect<void, unknown>;
  }
>()("@repo/analytics/CacheEventsStream") {}
export class ArtifactOpsStream extends Context.Service<
  ArtifactOpsStream,
  {
    readonly send: (events: readonly ArtifactOperationRecord[]) => Effect.Effect<void, unknown>;
  }
>()("@repo/analytics/ArtifactOpsStream") {}

/** Deployment-owned probabilities, keyed by organization ID. No sampling by untrusted header. */
export class AnalyticsSampling extends Context.Service<
  AnalyticsSampling,
  Readonly<Record<string, number>>
>()("@repo/analytics/AnalyticsSampling") {}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (millis: number) => {
  let time = "";
  for (let rest = millis, index = 0; index < 10; index++, rest = Math.floor(rest / 32))
    time = alphabet[rest % 32] + time;
  return (
    time +
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => alphabet[byte % 32]).join("")
  );
};
const label = (value: string | undefined) =>
  value && /^[A-Za-z0-9_.:/@-]{1,128}$/.test(value) ? value : null;
const common = (scope: AnalyticsScope, now: number, rate: number) => {
  const id = ulid(now);
  const ts = new Date(now).toISOString();
  return {
    id,
    event_id: id,
    ts,
    day: ts.slice(0, 10),
    schemaVersion: 1 as const,
    org_id: scope.orgId,
    project_id: scope.projectId,
    credential_type: scope.credentialType ?? "legacy",
    ci_provider: label(scope.ciProvider) ?? "local",
    sample_rate: rate,
  };
};
const rateFor = (rates: Readonly<Record<string, number>>, org: string) => {
  const rate = Object.hasOwn(rates, org) ? rates[org] : 1;
  return rate !== undefined && rate > 0 && rate <= 1 ? rate : 1;
};
const selected = (rate: number) =>
  rate === 1 || crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296 < rate;

export const AnalyticsEmitterBasin = Layer.effect(
  AnalyticsEmitter,
  Effect.gen(function* () {
    const stream = yield* CacheEventsStream;
    const rates = yield* AnalyticsSampling;
    const failures = Metric.counter("analytics_send_failures", {
      description: "Failed analytics stream sends",
    });
    return {
      emit: (scope, events) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rate = rateFor(rates, scope.orgId);
          const records = events
            .filter(() => selected(rate))
            .map((event) =>
              Schema.decodeUnknownSync(CacheEventRecord)({
                ...common(scope, now, rate),
                session_id: event.sessionId.slice(0, 128),
                source: event.source,
                event: event.event,
                hash: event.hash.slice(0, 256),
                duration_ms:
                  Number.isSafeInteger(event.duration) && event.duration! > 0 ? event.duration : 0,
                repo_id: label(scope.repoId),
                ref: label(scope.ref),
              }),
            );
          // One send per request batch. IDs are assigned once; any binding retry sees the same records.
          if (records.length)
            yield* stream
              .send(records)
              .pipe(Effect.mapError((cause) => new AnalyticsError({ cause })));
        }).pipe(
          Effect.tapError(() => Metric.update(failures, 1)),
          Effect.tapCause(Effect.logError),
        ),
    } satisfies typeof AnalyticsEmitter.Service;
  }),
);

export const ArtifactOpEmitterBasin = Layer.effect(
  ArtifactOpEmitter,
  Effect.gen(function* () {
    const stream = yield* ArtifactOpsStream;
    const rates = yield* AnalyticsSampling;
    const failures = Metric.counter("analytics_artifact_send_failures");
    return {
      emit: (scope: AnalyticsScope, operation: ArtifactOperation) =>
        Effect.gen(function* () {
          const rate = rateFor(rates, scope.orgId);
          if (!selected(rate)) return;
          const method = operation.method === "POST" ? "QUERY" : operation.method;
          if (!["GET", "HEAD", "PUT", "DELETE", "QUERY"].includes(method)) return;
          const now = yield* Clock.currentTimeMillis;
          const record = Schema.decodeUnknownSync(ArtifactOperationRecord)({
            ...common(scope, now, rate),
            operation: method,
            op: method.toLowerCase(),
            hash: operation.hash ?? "",
            status: operation.status,
            bytes: operation.bytes ?? 0,
            latency_ms: operation.latencyMs ?? 0,
            edge_cache: operation.edgeCache ?? "BYPASS",
            colo: label(operation.colo),
            credential_id: scope.credentialId ?? null,
            client_ci: label(operation.clientCi),
            interactive: scope.interactive ?? false,
          });
          yield* stream
            .send([record])
            .pipe(Effect.mapError((cause) => new AnalyticsError({ cause })));
        }).pipe(
          Effect.tapError(() => Metric.update(failures, 1)),
          Effect.tapCause(Effect.logError),
        ),
    } satisfies typeof ArtifactOpEmitter.Service;
  }),
);

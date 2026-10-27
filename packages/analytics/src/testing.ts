import type { ArtifactOperationRecord, CacheEventRecord } from "@repo/api-spec";
import { Context, Effect, Layer } from "effect";
import {
  AnalyticsEmitterBasin,
  ArtifactOpEmitterBasin,
  AnalyticsSampling,
  CacheEventsStream,
  ArtifactOpsStream,
} from "./stream-emitter.ts";

export class AnalyticsRecords extends Context.Service<
  AnalyticsRecords,
  {
    readonly cacheEvents: CacheEventRecord[];
    readonly artifactOps: ArtifactOperationRecord[];
  }
>()("@repo/analytics/AnalyticsRecords") {}

/** Fresh recording arrays for every layer build, with production validation and enrichment. */
export const AnalyticsEmitterTest = Layer.mergeAll(
  AnalyticsEmitterBasin,
  ArtifactOpEmitterBasin,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(
        CacheEventsStream,
        Effect.map(AnalyticsRecords, (records) => ({
          send: (events) =>
            Effect.sync(() => {
              records.cacheEvents.push(...events);
            }),
        })),
      ),
      Layer.effect(
        ArtifactOpsStream,
        Effect.map(AnalyticsRecords, (records) => ({
          send: (events) =>
            Effect.sync(() => {
              records.artifactOps.push(...events);
            }),
        })),
      ),
    ),
  ),
  Layer.provideMerge(Layer.sync(AnalyticsRecords, () => ({ cacheEvents: [], artifactOps: [] }))),
  Layer.provide(Layer.succeed(AnalyticsSampling, {})),
);

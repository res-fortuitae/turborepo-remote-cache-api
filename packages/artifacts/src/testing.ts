import { CoordinatorClientTest } from "@repo/coordinator";
import { CanonicalOrigin } from "@repo/deploy-config";
import { AnomaliesLive, AnomalyAlerts } from "./anomalies.ts";

import { AuditLogTest } from "@repo/audit/testing";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { QuotasLive, QuotaDefaults, QuotaEvictionLive } from "./quotas.ts";

/** Real quota transactions over fresh SQLite; small ceiling makes boundary cases inexpensive. */
export const QuotasTest = QuotasLive.pipe(
  Layer.provideMerge(AuditLogTest),
  Layer.provide(Layer.succeed(QuotaDefaults, { storageBytes: () => Effect.succeed(100) })),
  Layer.provideMerge(DatabaseTest),
);

/** Hosts supply their test inventory and purger so eviction exercises real object transitions. */
export const QuotaEvictionTest = QuotaEvictionLive.pipe(Layer.provideMerge(QuotasTest));

/** Live anomaly detection with fresh facts, coordinator state, and an inert delivery boundary. */
export const AnomaliesTest = AnomaliesLive.pipe(
  Layer.provideMerge(CoordinatorClientTest),
  Layer.provide(Layer.succeed(AnomalyAlerts, { notify: () => Effect.void })),
  Layer.provide(Layer.succeed(CanonicalOrigin, "https://cache.test")),
  Layer.provideMerge(AuditLogTest),
  Layer.provideMerge(DatabaseTest),
);

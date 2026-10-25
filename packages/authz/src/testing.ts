import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { AuthorizationDatabaseLive, AuthorizationAudit } from "./authorization.ts";

/** Fresh migrated facts with a per-build in-memory denial sink, no platform services. */
export const AuthorizationTest = AuthorizationDatabaseLive.pipe(
  Layer.provide(
    Layer.sync(AuthorizationAudit, () => {
      const events: unknown[] = [];

      return {
        deny: (principal, action, resource, reason) =>
          Effect.sync(() => {
            events.push({ principal, action, resource, reason });
          }),
      };
    }),
  ),
  Layer.provideMerge(DatabaseTest),
);

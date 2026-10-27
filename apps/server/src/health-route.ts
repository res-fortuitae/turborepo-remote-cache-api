import type { HealthReport } from "@repo/shared";
import { Effect } from "effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

type Probe<R> = Effect.Effect<unknown, unknown, R>;
/** Read-only probes; fixed public statuses never include exception text or configuration. */
export const healthRoute = <R>(
  checks: { d1: Probe<R>; r2: Probe<R>; kv: Probe<R>; coordinator: Probe<R> },
  capabilities: typeof HealthReport.Type.capabilities,
) =>
  Effect.gen(function* () {
    const status = (probe: Probe<R>) =>
      probe.pipe(
        Effect.timeout("3 seconds"),
        Effect.as("ok" as const),
        Effect.catch(() => Effect.succeed("error" as const)),
      );
    const [d1, r2, kv, coordinator] = yield* Effect.all(
      [status(checks.d1), status(checks.r2), status(checks.kv), status(checks.coordinator)],
      { concurrency: 4 },
    );
    const healthy = [d1, r2, kv, coordinator].every((value) => value === "ok");
    return yield* HttpServerResponse.json(
      {
        version: "0.1.0",
        schema_version: 1,
        healthy,
        checks: { d1, r2, kv, coordinator },
        capabilities,
      },
      { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  });

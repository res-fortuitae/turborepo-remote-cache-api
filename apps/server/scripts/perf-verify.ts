// Opt-in real JWT + cached epoch benchmark; never runs in the ordinary unit suite.
import {
  CoordinatorClientLive,
  CoordinatorNamespace,
  CoordinatorNamespaceTest,
} from "@repo/coordinator";
import {
  CacheTokenSigner,
  CacheTokenSignerLive,
  CacheTokenVerifier,
  CacheTokenVerifierLive,
  CacheTokenConfig,
  KeyStoreTest,
} from "@repo/credentials";
import { Effect, Layer } from "effect";

let remoteReads = 0;
const namespace = Layer.effect(
  CoordinatorNamespace,
  Effect.gen(function* () {
    const base = yield* CoordinatorNamespace.pipe(Effect.provide(CoordinatorNamespaceTest));
    return {
      getByName: (name: string) => {
        const instance = base.getByName(name);
        return {
          ...instance,
          scopeState: () => {
            remoteReads++;
            return instance.scopeState();
          },
        };
      },
    };
  }),
);
const dependencies = Layer.mergeAll(
  KeyStoreTest,
  CoordinatorClientLive.pipe(Layer.provide(namespace)),
  Layer.succeed(CacheTokenConfig, { issuer: "https://benchmark.invalid", maxTtlSeconds: 3600 }),
);
const layer = Layer.mergeAll(CacheTokenSignerLive, CacheTokenVerifierLive).pipe(
  Layer.provide(dependencies),
);
const samples = Number(Bun.env.PERF_SAMPLES ?? 1000);
const budget = Number(Bun.env.PERF_CPU_BUDGET_MS ?? 2);
if (
  !Number.isInteger(samples) ||
  samples < 100 ||
  samples > 10000 ||
  !Number.isFinite(budget) ||
  budget <= 0
)
  throw new Error("Invalid performance sample count/budget");
export const report = await Effect.runPromise(
  Effect.gen(function* () {
    const signer = yield* CacheTokenSigner,
      verifier = yield* CacheTokenVerifier;
    const { token } = yield* signer.issue({
      subject: "oidc:benchmark",
      org: "benchmark",
      project: "benchmark",
      scope: "read write",
    });
    for (let n = 0; n < 100; n++) yield* verifier.verify(token);
    const beforeReads = remoteReads,
      beforeCpu = process.cpuUsage();
    const timings: number[] = [];
    for (let n = 0; n < samples; n++) {
      const start = performance.now();
      yield* verifier.verify(token);
      timings.push(performance.now() - start);
    }
    const cpu = process.cpuUsage(beforeCpu);
    timings.sort((a, b) => a - b);
    const result = {
      samples,
      warmup: 100,
      wallP95Ms: timings[Math.ceil(samples * 0.95) - 1]!,
      processCpuMeanMs: (cpu.user + cpu.system) / 1000 / samples,
      remoteEpochReads: remoteReads - beforeReads,
      regressionBudgetMs: budget,
      sloTargetMs: 1,
      runtime: Bun.version,
      platform: `${process.platform}-${process.arch}`,
      scope:
        "Bun process CPU, real EdDSA JWT verification and real CoordinatorClient cache over an in-memory namespace; not Workers CPU",
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.processCpuMeanMs >= budget || result.remoteEpochReads !== 0)
      throw new Error("JWT hot-path performance regression");
    return result;
  }).pipe(Effect.provide(layer)),
);

import * as NodeURL from "node:url";
import { Miniflare } from "miniflare";
const build = await Bun.build({
  entrypoints: [NodeURL.fileURLToPath(new URL("./perf-worker.ts", import.meta.url))],
  target: "browser",
  minify: true,
  external: ["node:*"],
});
if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
const token = crypto.randomUUID();
const runtime = new Miniflare({
  modules: true,
  script: await build.outputs[0]!.text(),
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  r2Buckets: ["BUCKET"],
  bindings: { TOKEN: token },
  host: "127.0.0.1",
  port: 0,
});
try {
  const url = await runtime.ready;
  const child = Bun.spawn([Bun.env.K6_BIN || "k6", "run", "perf/fleet.js"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Bun.env,
      TURBO_API: url.origin,
      TURBO_TOKEN: token,
      TURBO_TEAM: "benchmark",
      PERF_EXPECT_EDGE: "1",
      PERF_ENFORCE_SLOS: Bun.env.PERF_ENFORCE_SLOS || "0",
      PERF_MULTIPART: "1",
      PERF_SCOPE:
        "local workerd/R2; synthetic scoped auth; no D1 authorization, quotas, OIDC or network geography",
      PERF_RAMP: Bun.env.PERF_RAMP || "2s",
      PERF_HOLD: Bun.env.PERF_HOLD || "5s",
      PERF_SUMMARY: Bun.env.PERF_SUMMARY || "perf/results/local-fleet.json",
    },
  });
  process.exitCode = await child.exited;
} finally {
  await runtime.dispose();
}

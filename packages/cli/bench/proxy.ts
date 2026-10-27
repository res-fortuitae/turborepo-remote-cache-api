// Local streaming throughput probe; no infrastructure or credentials required.
import { makeAuthRuntime, startProxy } from "../src/auth.ts";

const bytes = 64 * 1024 * 1024;
const paced = Bun.argv.includes("--paced");
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: bytes * 2,
  fetch: async (request) => {
    if (request.method === "PUT") {
      for await (const _chunk of request.body!) {
        /* consume streaming upload */
      }
      return new Response(null, { status: 202 });
    }
    let left = bytes;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (paced) await Bun.sleep(4);
          const size = Math.min(left, 1024 * 1024);
          if (size === 0) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(size));
          left -= size;
        },
      }),
      { headers: { "content-length": String(bytes) } },
    );
  },
});
Bun.env.TCACHE_API = upstream.url.origin;
Bun.env.TCACHE_TEAM = "benchmark";
Bun.env.TCACHE_PROJECT = "benchmark";
Bun.env.TCACHE_API_KEY = "local-only-benchmark";
const runtime = makeAuthRuntime();
const proxy = await startProxy(runtime);
if (!proxy) throw new Error("No proxy");
const measure = async (url: string, token: string) => {
  const start = performance.now();
  const response = await fetch(url + "/v8/artifacts/hash", {
    headers: { authorization: `Bearer ${token}` },
  });
  for await (const _chunk of response.body!) {
    /* consume stream without materialization */
  }
  return performance.now() - start;
};
try {
  const direct: number[] = [];
  const proxied: number[] = [];
  for (let i = 0; i < 12; i++) {
    const a = await measure(upstream.url.origin, "local-only-benchmark");
    const b = await measure(proxy.environment.TURBO_API, proxy.environment.TURBO_TOKEN);
    if (i > 1) {
      direct.push(a);
      proxied.push(b);
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const d = median(direct);
  const p = median(proxied);
  const loss = 100 * (1 - d / p);
  const budget = Number(Bun.env.PERF_PROXY_BUDGET_PERCENT ?? 5);
  console.log(
    JSON.stringify(
      {
        bytes,
        directMedianMs: d,
        proxyMedianMs: p,
        throughputLossPercent: loss,
        budgetPercent: budget,
        runtime: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        scope: paced
          ? "local download paced at 250 MiB/s; 10 measured runs"
          : "unpaced local loopback download, 10 measured runs",
      },
      null,
      2,
    ),
  );
  if (!Number.isFinite(budget) || loss > budget)
    throw new Error("Proxy throughput budget exceeded");
} finally {
  proxy.stop();
  await runtime.dispose();
  await upstream.stop(true);
}

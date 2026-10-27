/* global __ENV, __VU, __ITER, open */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const api = (__ENV.TURBO_API || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(api) || !__ENV.TURBO_TOKEN)
  throw new Error("TURBO_API and TURBO_TOKEN required");
const prefix =
  (__ENV.PERF_RUN_ID || String(Date.now())).replace(/[^a-fA-F0-9]/g, "").slice(0, 20) || "abcdef";
const team = __ENV.TURBO_TEAM || "benchmark";
const headers = { Authorization: `Bearer ${__ENV.TURBO_TOKEN}` };
const query = `?teamId=${encodeURIComponent(team)}`;
const vus = Number(__ENV.PERF_VUS || 200);
const enforce = __ENV.PERF_ENFORCE_SLOS !== "0";
if (!Number.isInteger(vus) || vus < 1 || vus > 2000) throw new Error("PERF_VUS must be 1..2000");
const multipart = __ENV.PERF_MULTIPART === "1";
const expectEdge = __ENV.PERF_EXPECT_EDGE !== "0";
const big = __ENV.PERF_LARGE !== "0";
const tokens = __ENV.PERF_OIDC_TOKENS ? open(__ENV.PERF_OIDC_TOKENS).trim().split("\n") : [];
const warmGet = new Trend("warm_get_ms", true);
const r2Get = new Trend("r2_get_ms", true);
const head = new Trend("head_ms", true);
const metadata = new Trend("metadata_50_ms", true);
const exchange = new Trend("exchange_ms", true);
const multipartMs = new Trend("multipart_ms", true);
const failures = new Rate("operation_failures");
const smallPayload = "x".repeat(64 * 1024);
// Allocate large payloads only in the scenarios which need them, never once per fleet VU.
export const options = {
  discardResponseBodies: true,
  systemTags: ["status", "method", "name", "scenario", "expected_response"],
  scenarios: {
    fleet: {
      executor: "ramping-vus",
      exec: "fleet",
      startVUs: 0,
      stages: [
        { duration: __ENV.PERF_RAMP || "10s", target: vus },
        { duration: __ENV.PERF_HOLD || "20s", target: vus },
        { duration: "3s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
    ...(big
      ? {
          r2: {
            executor: "shared-iterations",
            exec: "large",
            vus: 1,
            iterations: Number(__ENV.PERF_LARGE_SAMPLES || 20),
            maxDuration: "2m",
          },
        }
      : {}),
    ...(multipart
      ? {
          multipart: {
            executor: "shared-iterations",
            exec: "uploadMultipart",
            vus: 1,
            iterations: Number(__ENV.PERF_MULTIPART_SAMPLES || 2),
            maxDuration: "3m",
          },
        }
      : {}),
    ...(tokens.length
      ? {
          exchange: {
            executor: "shared-iterations",
            exec: "oidc",
            vus: 1,
            iterations: tokens.length,
            maxDuration: "2m",
          },
        }
      : {}),
  },
  thresholds: {
    operation_failures: ["rate==0"],
    ...(enforce
      ? { warm_get_ms: ["p(95)<100"], head_ms: ["p(95)<150"], metadata_50_ms: ["p(95)<150"] }
      : {}),
    ...(big && enforce ? { r2_get_ms: ["p(95)<400"] } : {}),
    ...(tokens.length && enforce ? { exchange_ms: ["p(95)<300"] } : {}),
  },
};
function checked(response, status, label) {
  const ok = check(response, { [label]: (r) => r.status === status });
  failures.add(!ok);
  if (!ok) fail(`${label} returned ${response.status}`);
  return response;
}
function requestParams(name, json = false) {
  return {
    headers: { ...headers, ...(json ? { "content-type": "application/json" } : {}) },
    tags: { name },
    redirects: 0,
    timeout: "30s",
  };
}
export function setup() {
  const hashes = Array.from(
    { length: 50 },
    (_, i) => `${prefix}${i.toString(16).padStart(4, "0")}`,
  );
  for (const hash of hashes)
    checked(
      http.put(`${api}/v8/artifacts/${hash}${query}`, smallPayload, requestParams("seed")),
      202,
      "seed upload",
    );
  // Warm the per-location edge copy before recording warm latency.
  for (const hash of hashes)
    checked(
      http.get(`${api}/v8/artifacts/${hash}${query}`, requestParams("warmup")),
      200,
      "warmup",
    );
  return { hashes };
}
export function fleet({ hashes }) {
  const hash = hashes[(__VU + __ITER) % hashes.length];
  const response = checked(
    http.get(`${api}/v8/artifacts/${hash}${query}`, requestParams("warm_get")),
    200,
    "warm GET",
  );
  if (expectEdge) {
    const hit = check(response, { "edge HIT": (r) => r.headers["X-Edge-Cache"] === "HIT" });
    failures.add(!hit);
  }
  warmGet.add(response.timings.duration);
  head.add(
    checked(http.head(`${api}/v8/artifacts/${hash}${query}`, requestParams("head")), 200, "HEAD")
      .timings.duration,
  );
  metadata.add(
    checked(
      http.post(
        `${api}/v8/artifacts${query}`,
        JSON.stringify({ hashes }),
        requestParams("metadata_50", true),
      ),
      200,
      "50-hash metadata",
    ).timings.duration,
  );
  if (__ITER % 10 === 0)
    checked(
      http.put(
        `${api}/v8/artifacts/${prefix}ff${__VU.toString(16)}${__ITER.toString(16)}${query}`,
        smallPayload,
        requestParams("upload_64k"),
      ),
      202,
      "fleet PUT",
    );
  sleep(Number(__ENV.PERF_PACING_SECONDS || 1));
}
export function large() {
  const hash = `${prefix}ee${__ITER.toString(16)}`;
  checked(
    http.put(
      `${api}/v8/artifacts/${hash}${query}`,
      "r".repeat(10_000_000),
      requestParams("seed_10mb"),
    ),
    202,
    "10 MB seed",
  );
  const response = checked(
    http.get(`${api}/v8/artifacts/${hash}${query}`, requestParams("r2_get_10mb")),
    200,
    "10 MB GET",
  );
  const miss = check(response, {
    "R2-backed, not edge HIT": (r) => r.headers["X-Edge-Cache"] !== "HIT",
  });
  failures.add(!miss);
  r2Get.add(response.timings.duration);
}
export function uploadMultipart() {
  const hash = `${prefix}dd${__ITER.toString(16)}`;
  const created = checked(
    http.post(
      `${api}/v8/x/uploads`,
      JSON.stringify({ hash, size: 64 * 1024 * 1024 + 1024 * 1024 }),
      { ...requestParams("multipart_create", true), responseType: "text" },
    ),
    201,
    "multipart create",
  ).json();
  const start = Date.now();
  let completed = false;
  try {
    const parts = [];
    for (let n = 1; n <= 2; n++) {
      const response = checked(
        http.put(
          `${api}/v8/x/uploads/${created.id}/parts/${n}`,
          "m".repeat(n === 1 ? 64 * 1024 * 1024 : 1024 * 1024),
          { ...requestParams("multipart_part"), responseType: "text" },
        ),
        200,
        "multipart part",
      );
      parts.push(response.json());
    }
    checked(
      http.post(
        `${api}/v8/x/uploads/${created.id}/complete`,
        JSON.stringify({ parts }),
        requestParams("multipart_complete", true),
      ),
      202,
      "multipart completion",
    );
    completed = true;
    checked(
      http.head(`${api}/v8/artifacts/${hash}${query}`, requestParams("multipart_head")),
      200,
      "multipart artifact",
    );
    multipartMs.add(Date.now() - start);
  } finally {
    // Abort only unfinished sessions; a completed upload no longer needs cleanup.
    if (!completed)
      http.post(
        `${api}/v8/x/uploads/${created.id}/abort`,
        null,
        requestParams("multipart_cleanup"),
      );
  }
}
export function oidc() {
  const response = checked(
    http.post(
      `${api}/oidc/exchange`,
      JSON.stringify({ token: tokens[__ITER], team: __ENV.PERF_ORG, project: __ENV.PERF_PROJECT }),
      {
        headers: { "content-type": "application/json" },
        tags: { name: "exchange" },
        redirects: 0,
        responseType: "none",
      },
    ),
    200,
    "OIDC exchange",
  );
  exchange.add(response.timings.duration);
}
export function handleSummary(data) {
  return {
    [__ENV.PERF_SUMMARY || "perf-summary.json"]: JSON.stringify(
      {
        ...data,
        sloObservations: Object.fromEntries(
          Object.entries({
            warm_get_ms: 100,
            head_ms: 150,
            metadata_50_ms: 150,
            r2_get_ms: 400,
            exchange_ms: 300,
          }).map(([name, target]) => [
            name,
            {
              targetMs: target,
              p95Ms: data.metrics[name]?.values?.["p(95)"] ?? null,
              met:
                data.metrics[name]?.values?.["p(95)"] === undefined
                  ? null
                  : data.metrics[name].values["p(95)"] < target,
            },
          ]),
        ),
        benchmark: {
          enforceSLOs: enforce,
          target: api.split("/")[2],
          vus,
          multipart,
          expectEdge,
          large: big,
          oidcSamples: tokens.length,
          runId: prefix,
          scope: __ENV.PERF_SCOPE || "operator-supplied target",
        },
      },
      null,
      2,
    ),
  };
}

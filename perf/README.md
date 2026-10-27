# Performance and release probes (STV-508)

Use Bun for the orchestration scripts. Fleet traffic uses the standalone Grafana
k6 CLI. Local probes provision only disposable local workerd storage; they never
deploy a Cloudflare resource. Run from the repository root.

```sh
bun run perf:smoke     # real EdDSA verification + cached epoch, CPU regression guard
bun run perf:exchange  # real OIDC verification/replay/policy/audit/anomaly pipeline
bun run perf:proxy     # 64 MiB paced streaming download, direct vs actual CLI proxy
bun run perf:local     # k6, 200 fleet VUs + 10 MB reads + 65 MiB multipart in workerd
```

Install k6 separately (no hosted service/account is needed), or set `K6_BIN` to
its executable. This baseline used k6 v2.3.0 from Grafana's release, verified
against its published SHA-256 checksum. The local workerd fixture uses the
repository's pinned Miniflare compatibility date, `2026-07-30`.

## Targets and scope

A deployed staging/preview release gate requires warm edge GET p95 below 100 ms,
a cold R2-backed 10,000,000-byte GET below 400 ms, HEAD and 50-hash metadata POST
below 150 ms, cached-JWKS OIDC exchange below 300 ms, token verification CPU below
1 ms, and proxy throughput loss below 5%.

The fixture exercises production HTTP handlers, edge-cache logic, streaming R2,
and signed multipart tickets through real workerd/R2 bindings. Its synthetic
scoped credential excludes D1 authorization, quotas, revocation network calls and
anomaly writes. The independent JWT probe exercises real crypto and the real
CoordinatorClient cache, and asserts zero namespace reads during its warmed
sample window. The exchange probe uses migrated SQLite, the real OIDC verifier,
replay guard, policy matcher, signer, audit and anomaly hooks; only the JWKS
transport, rate limiter and Coordinator transport are in memory. These are
local measurements, not deployed SLO evidence.

`perf:local` enforces successful operations and actual edge HITs. It reports
latency SLO observations but defaults to `PERF_ENFORCE_SLOS=0`, because one local
workerd process and the load generator contend for the same machine. Set
`PERF_ENFORCE_SLOS=1` to fail on latency misses too. The raw k6 entry point defaults
to enforcing all latency thresholds. Missing optional measurements are `null`,
never a pass. A successful fixture run does not mean latency targets were met.

The 200-VU fixture run ramps over two seconds, holds for five, then ramps down
for three, with one-second job pacing. A normal staging run ramps over ten
seconds and holds for twenty. Increase the hold duration for release soak tests.
Large transfers use separate low-concurrency scenarios to avoid allocating a
64 MiB body per fleet VU; uploads still overlap fleet traffic. There are 50 seeded
64 KiB artifacts, mixed GET/HEAD/50-hash query traffic, a fresh 64 KiB upload every
ten job iterations, twenty cold 10 MB reads and two 65 MiB multipart uploads.
Each large GET uses a freshly uploaded hash and checks that it was not an edge
HIT. Every multipart upload completes and checks the resulting artifact.

## Staging release gate

Use an isolated disposable project and scoped credentials with sufficient
capacity/rate limits. This test writes artifacts which expire under retention;
it does not delete unrelated project data or deploy a stage. Supply credentials
through the environment, never command-line arguments or committed files.

```sh
# TURBO_API, TURBO_TOKEN and TURBO_TEAM are set in the invoking environment.
k6 run -e PERF_MULTIPART=1 -e PERF_HOLD=2m \
  -e PERF_SUMMARY=/tmp/release-fleet.json perf/fleet.js
```

Optional exchange traffic reads one fresh CI assertion per line from
`PERF_OIDC_TOKENS` (a local filename), with `PERF_ORG` and `PERF_PROJECT` set.
Use at least 100 unique, unexpired assertions for useful p95 measurements;
reusing a token correctly fails replay validation. Use a dedicated read-only
trust policy for this unbound probe. DPoP-required write policies must be tested
through the actual bound proxy, not weakened for a benchmark. Never commit the
assertion file. The summary excludes tokens, response bodies and request URLs.

`PERF_RUN_ID` (hex), `PERF_VUS`, `PERF_RAMP`, `PERF_HOLD`, `PERF_PACING_SECONDS`,
`PERF_LARGE_SAMPLES`, and `PERF_MULTIPART_SAMPLES` control the workload. Set
`PERF_LARGE=0` or `PERF_MULTIPART=0` for a smaller probe. Set `PERF_EXPECT_EDGE=0`
only when evaluating a documented residency/no-edge configuration; that result
must not be reported as the warm-edge SLO. The script does not synthesize artifact
signatures; signing-required projects need a signing-aware client probe.

## Regression and release evidence

`perf:smoke` fails if mean process CPU exceeds 2 ms or a warmed epoch read goes
remote. The target remains 1 ms; 2 ms is the coarse regression guard for noisy
local/CI hosts. `PERF_CPU_BUDGET_MS` and `PERF_SAMPLES` support a controlled runner.
The Validate workflow includes the smoke for when GitHub Actions is available;
the same command runs locally without CI. The proxy probe fails above 5% loss
(`PERF_PROXY_BUDGET_PERCENT` overrides the comparison budget).

Commit sanitized summaries and the host/runtime/workload description to release
notes before launch. Repeat after material auth, cache, proxy or upload changes.
See [the initial local report](results/2026-10-27.md). Release checks require
`bun run check`, `bun run test`, `bun run dashboard:build` and `bun run test:stack`
as well; load tests complement the functional/permission suites.

[The follow-up validation](../docs/stv-508-validation.md) includes rerun metrics,
isolated diagnostics and real macOS-to-OCI CLI/cache journeys. Its local results
do not replace the deployed mixed-workload release gate.

References: [k6 ramping VUs](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-vus/),
[k6 custom metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/create-custom-metrics/).

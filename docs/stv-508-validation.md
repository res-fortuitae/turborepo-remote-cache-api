# STV-508 follow-up validation — 27 October 2026

The application fixes in this follow-up are locally validated. **STV-508 is still
In Progress:** its acceptance criteria require a preview deployment and latency
SLOs under a 200-job mixed workload. The user explicitly required all application
infrastructure to remain local. No Cloudflare deployment or destruction occurred.
The local mixed workload still misses its latency targets; it is not an SLO pass.

[Additional OIDC verification](oidc-validation.md) subsequently passed the actual
local root-stack exchange, DPoP, CLI/Turbo, refresh and audit checks. It preserves
the distinction between locally signed test assertions and real CI-issued tokens.

## Environment and test boundaries

The backend was the actual root Alchemy composition, stage `stv508-validation`,
running local workerd, D1 migrations, R2, KV, Coordinator Durable Objects, Secrets
Store, rate limits, crons and production dashboard assets at `http://localhost:1337`.
Alchemy and its Cloudflare provider are the published, unmodified 2.0.0-beta.84
packages. No custom dependency patch or dependency source modification was used.

Four temporary users and initial browser sessions were inserted only into that
stage's empty local D1 database. This is a deliberate identity bootstrap fixture,
**not evidence of a real GitHub OAuth registration or first-user bootstrap**.
After bootstrap, administration, invitations, device grants, token issuance,
permissions, storage and telemetry used the real HTTP application and database.
A generated Ed25519 key was supplied only to the test process; existing root
secrets were not overwritten.

The second device was the user's OCI ARM64 Linux host, reached using `ssh oci`.
A loopback-only reverse SSH tunnel connected it to the local Worker. Bun 1.4.3,
the compiled `tcache` Linux ARM64 executable and Turbo 2.11.10 ran from a private
`/tmp` directory, with a separate CLI home. No application infrastructure was
provisioned there. The source machine used compiled macOS ARM64 `tcache` and the
same Bun and Turbo versions. This verifies device separation and an SSH network
path, not Cloudflare edge geography or a production TLS endpoint.

## Real journeys

| Flow                                                             | Result and evidence                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance owner creates organization, optional group and projects | HTTP and real Chromium UI passed                                                                                                            |
| Ordinary user attempts organization/project creation             | 403; owner paths succeed                                                                                                                    |
| Signed invitations                                               | Correct recipient accepts once; outsider and replay rejected; UI invitation and acceptance passed                                           |
| Group and direct project grants                                  | Group member obtains writer token; direct reader obtains read token                                                                         |
| CLI account and linking                                          | Actual compiled CLI `whoami` and `link` passed with real bearer sessions                                                                    |
| CLI device authorization                                         | Real device verification, approval, polling and private persistence passed on macOS and OCI                                                 |
| Default developer credentials                                    | Read-only; write request refused while instance policy disabled; reader still denied after enabling it                                      |
| Explicit developer writes                                        | `exec --strict --write` uploads under current project permission and policy                                                                 |
| Cross-device cache                                               | macOS writer misses/uploads; fresh OCI reader gets remote hit, restores identical bytes and uploads nothing                                 |
| Signed cross-device cache                                        | Rotated signing key, required signatures, producer upload and OCI reader verification all passed                                            |
| Cache tampering                                                  | Replacing the isolated signed artifact's tag with an invalid signature prevents Turbo restoration                                           |
| Tenant/project isolation                                         | Wrong tenant rejected; identical hash absent in another project, then holds independent bytes there                                         |
| Anonymous/read-only access                                       | Anonymous GET 401; reader GET/HEAD/query succeed; reader PUT and write-token request denied                                                 |
| CSRF                                                             | Missing Origin on project mutation rejected                                                                                                 |
| Quotas                                                           | Small storage budget reports `over_limit`, refuses PUT, keeps reads available; reset succeeds                                               |
| Archive/restore                                                  | Archived project permits reads, refuses PUT; restore succeeds                                                                               |
| Scoped API key                                                   | Create/read/list pass; list omits secret; emergency revoke rejects key and old project JWT                                                  |
| Fresh JWT after epoch bump                                       | Newly issued reader token works                                                                                                             |
| Grant removal                                                    | Prevents subsequent developer token issuance; grant restoration succeeds                                                                    |
| Project deletion                                                 | Immediately denies an existing credential access to the previously cached signed artifact                                                   |
| Incident purge                                                   | Real minute cron scans, preview identifies one object, confirmation deletes it, completed job reports one removal and subsequent GET is 404 |
| Audit                                                            | Owner reads events; reader denied; JSONL export contains 111 valid events and no known session/cache-token material                         |
| Analytics access                                                 | Outsider denied                                                                                                                             |
| Upload provenance                                                | Persisted upload row identifies the actual writer's user ID and Turbo hash                                                                  |
| Browser                                                          | Seven real API journeys; zero uncaught JavaScript errors and zero HTTP 5xx responses                                                        |
| Logout                                                           | Actual macOS and OCI CLI revoke their sessions and remove private files; subsequent OCI whoami fails                                        |

The unsigned cache hash was `707f87ca2287817b`; the signed hash was
`509331810ce804f9`. In both cases, restored output SHA-256 was
`ecc0ef06dfaf64351ce6c8b45f24848e616fecf232644c86666dc8243680b6ab`.
OCI started without `dist` or `.turbo`, and used `--cache=remote:r`. Its build
command was replaced by a program that exits 86, so a miss could not produce a
successful run. The successful runs reported one cache hit, zero misses/uploads
and identical output. Turbo replays cached build logs: `BUILD_EXECUTED` appearing
in a hit's log does not mean the command executed on OCI. A first file-transfer
attempt included macOS AppleDouble metadata, correctly changing Turbo's inputs
and producing a miss; the passing runs used identical source inputs.

The temporary HTTP/browser drivers were disposable test tools. Durable regression
coverage is in the bearer organization integration test, scoped tenant HTTP test,
CLI write/persistence tests, signing-key preflight test, existing security suites
and root stack suite. [Sanitized browser results](../perf/results/2026-10-27-followup/browser.json)
record the seven real UI checks. Existing unit/integration coverage additionally
exercises policy matching, DPoP replay, signature rotation, multipart cleanup,
auth revocation, quota races, maintenance and audit integrity.

## Bugs found and fixed

1. Organization CLI bearer sessions returned 401 even though `/get-session`
   succeeded. Better Auth accumulates header changes until all before hooks
   complete; our before hooks called its raw session endpoint before bearer
   normalization was applied. Session readers now dispatch through the documented
   `auth.api.getSession` API, retaining the separate live D1 checks. The regression
   test failed before the fix and passes for valid, invalid and revoked sessions.
2. Turbo sends non-`team_` team IDs through `slug`. UUID IDs saved by `tcache link`
   therefore caused tenant mismatch and zero uploads. The server now accepts its
   credential's exact organization ID or slug in that parameter; every supplied
   value must match, and other tenants remain denied. The regression test failed
   before the fix.
3. The server already supported explicit developer writes, but the CLI never
   requested them. `--write` now requests that capability; defaults stay read-only,
   and server policy/grants still control issuance. The regression test failed
   before the fix and covers server rejection too.
4. The documented random-string signing-secret setup caused token issuance to
   return 503. `bun run keygen --out /private/path/signing-key.json` generates a
   private Ed25519 set; root dev/plan/deploy scripts validate it before Alchemy
   starts. Validation errors do not include key material or their underlying cause.
5. The performance Worker no longer bundled after the provider split because
   shared exports pulled in Alchemy's control plane. Request-path modules now use
   the existing `@repo/coordinator/client` entry point. `perf:local` bundles/runs
   again and respects an explicit `PERF_MULTIPART=0` diagnostic setting.
6. macOS native credential storage waited for OS interaction in this unattended
   run. `login --file-session` explicitly chooses the existing 0600-file/0700-dir
   format without calling the OS store. Default OS storage is preserved; native
   interactive Keychain approval was not certified by this run.

## Audit and access-history limits

Audit reliably records administration, token issuance, device decisions and
**authorization denials**. `cache.read` entries in this local audit sample are
denials, not successful-download receipts. Upload provenance identifies who wrote
which hash. Lite analytics persists project/org hit/miss aggregates; it does not
retain a complete per-user, per-hash successful-download ledger. Token issuance
alone does not prove that its owner downloaded a particular artifact.

The configured Basin artifact-operation stream can include hash, credential ID,
status, bytes, latency and edge outcome, subject to sampling and best-effort
asynchronous delivery. Local mode does not run that cloud integration. Thus
**complete “who downloaded which cache” history is not a verified capability of
this local installation**. A durable local read-access history would require an
additional product change; it must not be inferred from current audit coverage.

## Performance evidence

Same-host synthetic scoped-auth workerd fixture, k6 2.3.0. Local CPU measurements
are Bun process CPU, not Cloudflare billing CPU. These runs are distinct from the
full-auth functional journeys above; the load fixture deliberately excludes D1
authorization, quotas and network revocation calls.

| Probe                                                  | Follow-up result | Interpretation                                                   |
| ------------------------------------------------------ | ---------------: | ---------------------------------------------------------------- |
| 200 fleet VUs plus R2 and multipart: warm GET p95      |        841.04 ms | Fails <100 ms                                                    |
| Same mixed run: cold 10 MB R2 GET p95                  |        518.36 ms | Fails <400 ms                                                    |
| Same mixed run: HEAD p95                               |        553.79 ms | Fails <150 ms                                                    |
| Same mixed run: 50-hash query p95                      |        685.20 ms | Fails <150 ms                                                    |
| Mixed operation failures                               |                0 | Functional success only; both 65 MiB multipart uploads succeeded |
| One fleet VU, no large/multipart overlap: warm GET p95 |          5.17 ms | Isolated local pass only                                         |
| Same isolated run: HEAD / query p95                    |  3.08 / 16.58 ms | Isolated local pass only                                         |
| JWT mean process CPU                                   |         0.117 ms | Pass locally, zero warmed remote epoch reads                     |
| Cached-JWKS exchange p95                               |          1.02 ms | Pass with local test transports                                  |
| Paced 64 MiB proxy throughput comparison               | No measured loss | Ten local paired runs; not a WAN or multipart guarantee          |

One VU **with** large-transfer overlap still missed the warm-GET target
(p95 267.97 ms), although HEAD, query and cold R2 targets passed. Removing that
overlap isolates a fast small-artifact path. This supports shared local contention
as a factor; it does not prove the cause of deployed latency or excuse the mixed
load failure. Missing measurements remain null. Do not replace the 200-job release
workload with the smaller diagnostic run and call the milestone complete.

Sanitized summaries: [fleet](../perf/results/2026-10-27-followup/fleet.json),
[single mixed](../perf/results/2026-10-27-followup/single-mixed.json),
[single isolated](../perf/results/2026-10-27-followup/single-isolated.json),
[JWT](../perf/results/2026-10-27-followup/verification.json),
[exchange](../perf/results/2026-10-27-followup/exchange.json),
[proxy](../perf/results/2026-10-27-followup/proxy.json).

## Remaining validation and local runtime findings

- No deployed preview latency, Workers CPU, geographic edge-cache or production
  TLS result. The user prohibited application deployments for this task.
- No real external GitHub OAuth, CI-provider assertion, passkey hardware prompt,
  email delivery or Basin export was performed in this follow-up. Their local
  adapters/security tests are separate evidence, not live-provider certification.
- A fresh unmodified beta.84 local startup failed Secrets Store seeding with
  `SQLITE_BUSY`; restart succeeded. Earlier passing stack runs did not establish
  that beta.84 eliminated all startup races. No dependency patch was introduced.
- Rapid local HTTP sequences after rejected uploads repeatedly produced an
  `ECONNRESET` on a subsequent request when reusing connections. The temporary
  negative-flow driver used fresh connections to finish the behavioral checks.
  A minimal upstream Miniflare early-denial reproduction did not reset, so the
  exact Alchemy-runtime/application interaction remains unresolved. CLI cache
  restore, browser journeys and ordinary HTTP checks above passed independently.

Model: gpt-6.1-sol; agent: Codex (/root); harness: T3 Code / Codex.

## Final checks and cleanup

`bun run check` and all 41 workspace tasks in `bun run test` passed. The actual
root local Alchemy stack suite passed **40/40** checks, using a generated ephemeral
signing key rather than changing the existing root secret. That command includes
the production dashboard build. `bun install --frozen-lockfile` changed nothing,
and `bun audit --json` returned `{}`. Compiled CLI persistence/write tests passed.

All four bootstrap users and their sessions were removed from the isolated local
D1 database. macOS and OCI CLI logout succeeded, the SSH tunnel and local dev
process were stopped, and the OCI temporary binaries/workspaces were removed.
Temporary local drivers contained only disposable fixture credentials and were
removed after recording sanitized evidence. Root environment files were preserved.

Recorded at 2026-10-27T12:30:21.317Z.

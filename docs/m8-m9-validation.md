# M8 / M9 local validation — 2026-10-27

Validation was performed on the cumulative stack, continuing the existing
STV-490 branch above PR #71. No remote deployment or GitHub CI was used.
Canceled/duplicate milestone tickets were left in their recorded states.
Implementation PRs remain open for review; this record does not imply merging
or production launch approval.

## Review stack

| Scope                   | Tickets                 | Pull requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M8 dashboard            | STV-466 through STV-473 | [#62](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/62), [#63](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/63), [#64](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/64), [#65](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/65), [#66](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/66), [#67](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/67), [#68](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/68), [#69](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/69) |
| M9 signatures / quotas  | STV-475, STV-476        | [#70](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/70), [#71](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/71)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M9 anomaly detection    | STV-490                 | [#72](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/72)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M9 performance probes   | STV-508                 | [#73](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/73)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M9 threat model / fixes | STV-474                 | [#74](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/74), based on #73                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Each PR builds on the previous branch. Review/merge from the bottom of the stack.

## Local checks

- Frozen Bun 1.4.3 installation succeeds with the committed lockfile v3.
- `bun audit --json` returns `{}` after patched same-major dependency overrides.
- `bun run check` covers boundaries, migration/schema consistency, lint,
  workspace type checks and formatting. Existing warning severities are retained.
- `bun run test` passes all 41 workspace tasks, including Action bundle freshness,
  real Turbo, dashboard contracts/router tests, real local D1, OIDC/replay,
  authorization, credentials, audit integrity, quotas, uploads and anomaly suites.
- `bun run test:stack` builds the production dashboard and passes all 40 checks
  against the root Alchemy local workerd stack: assets/CSP, auth, device codes,
  health/capabilities, HTTP contract, permission matrix and real Turbo round trip.
- The final JWT probe measures 1,000 real EdDSA verifications at approximately
  0.117 ms mean process CPU, with zero warmed remote epoch reads. The real local
  cached-JWKS exchange pipeline measures approximately 0.81 ms p95 over 100
  samples. These are local Bun/SQLite measurements, not Workers CPU/network SLOs.
- The paced 64 MiB direct/proxy comparison passes its 5% throughput-loss budget;
  see [the baseline report](../perf/results/2026-10-27.md).
- A final k6/workerd run after hardening reaches 200 fleet VUs plus R2/multipart
  traffic: **2,732 HTTP requests, zero failed HTTP requests and zero failed
  operation checks**. Both 65 MiB multipart uploads complete. The fixture uses
  production routes/adapters with synthetic scoped auth; full authorization is
  covered separately by the functional suites.

The security regression suites check downstream `no-store` on cold/warm reads,
retained private edge caching, tenant/auth isolation, served CSP compatibility,
real encrypted GitHub OAuth storage, audit redaction and reauthentication of a
legacy plaintext account. The performance probe also found and fixed the
opaque-R2-ETag length defect. Its multipart cleanup now aborts unfinished
sessions only.

## Limits and launch gates

The 200-job mixed-load **latency targets still miss locally**: final p95 is about
907 ms for warm GET, 565 ms for HEAD, 784 ms for 50-hash metadata and 525 ms for
10 MB cold R2 GET. Those observations are retained as failures of the local
latency targets. Local fixture operation success does not establish staging
SLO compliance. Run the enforcing staging probe from a separate load generator
on an authorized deployment before launch.

A targeted headless Chromium 1.64.1 walkthrough of the compiled production
bundle passed five flows under the real production CSP: custom-role invitation
visibility without `ac:read`, invitation submission and keyboard dismissal,
project grant selection and effective-access explanation, project tab navigation,
and mobile navigation opening/keyboard dismissal. No JavaScript or CSP errors
were observed. API responses were synthetic; the backend permission/transaction
checks run separately against migrated SQLite. This is not a full OAuth/passkey
browser journey.

Pre-merge independent standards/spec reviews found and fixed multipart quota
cleanup, organization-tightened passkey policy, custom-role UI gating,
project-admin directory authorization, and multi-role anomaly delivery. Regression
cases cover the identified failures. The final hardening PR contains these fixes
for the cumulative stack.

No custom dependency patches are retained. Alchemy and its Cloudflare provider
are pinned to the published `2.0.0-beta.84` packages; provider imports use
`@alchemy.run/cloudflare`, and the direct Cloudflare SDK matches the provider's
`1.0.0-rc.17` dependency. The unmodified beta.83 local stack reproduced a
Secrets Store seeding failure (`Network connection lost.`); the unmodified
beta.84 stack passes all 40 checks. This establishes a working upstream upgrade,
without claiming the precise internal cause of the beta.83 failure.

Official [local-development documentation](https://alchemy.run/cloudflare/local-development/)
confirms Secrets Store values are seeded into the local simulator. Published
[beta.84 release notes](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.84)
include a [related cross-script Durable Object reconnection fix](https://github.com/alchemy-run/alchemy/pull/2325)
and the provider-package migration used here.

No real hosted CI issuer, hosted release signing, deployed email delivery or
independent penetration test was performed.
The local stack verifies the built assets and their CSP structurally. Existing
OAuth rows/backups and pre-upgrade downstream cache entries need the operational
remediation in [the security review](threat-model.md).
A maintainer must review the security findings/residual risks before launch.

Model: gpt-6.1-sol · Agent: Codex · Harness: T3 Code/Codex · Timestamp: 2026-10-27T11:35:16Z

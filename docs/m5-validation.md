# M5 local validation record

Validated on 2026-10-27 with Bun 1.4.3, macOS arm64, and local Docker. No
infrastructure, npm packages, GitHub Releases, Homebrew tap or GHCR images were
published. Publication is deferred by explicit user request.

| Stack layer                     | PR                                                                        | Local evidence                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STV-454 device authorization    | [49](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/49) | D1/KV-enabled flow, approval/denial audit, polling slow-down and one-time redemption; dashboard build                                                             |
| STV-455 developer tokens        | [50](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/50) | Real JWT verification, default read scope, write policy/grant checks, live session/grant revocation, TTL and audit redaction                                      |
| STV-453 CLI                     | [51](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/51) | Effect CLI subprocess account/link/permission/exit-code tests; proxy refresh/upload/HEAD/cleanup tests                                                            |
| STV-456 CI auth                 | [52](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/52) | Seven subprocess cases for GitLab, CircleCI, Buildkite, Bitbucket, API-key fallback, missing identity and denial                                                  |
| STV-489 doctor                  | [53](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/53) | Fixed health success/failure, admin/non-admin self-test, real handler/storage round trip, cleanup failure, audit and diagnostic redaction                         |
| STV-488 distribution candidates | [54](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/54) | Seven cross-compiled targets, complete SHA-256 verification, compiled CLI integration, Docker, installer tamper test, local npm launcher/pack and Homebrew syntax |

Final workspace `bun run check` and `bun run test` passed (23 check tasks and 40
test tasks). The server suite reported 115 passing tests and 41 environment-gated
skips; no deployed/live suites were claimed. The native compiled CLI separately
passed six account/proxy integration tests with 61 assertions on both macOS arm64
and Linux arm64 (local Docker), including saved
developer session → token exchange → default exec → upstream bearer request.
A regression first reproduced incorrect DPoP authentication for developer tokens;
the fix preserves OIDC binding and uses bearer authentication for unbound developer
tokens, on both ordinary reads and multipart uploads. Checked-in Action bundles
were rebuilt from the corrected client-core source.

The root Alchemy **local** stack passed 39 tests with 83 assertions, exercising
real workerd, D1, R2, KV, coordinator and Secrets Store bindings, real Turbo cache
round trips, M5 health dependencies and device-code/pending-token transport.
All six real Turbo compatibility combinations passed locally (versions 2.11.10,
2.10.13 and 1.13.4, each in direct and proxy modes: 30 tests, 210 assertions).

All seven targets compile within the 128 MiB binary budget. macOS arm64 measured
71,242,226 bytes with 33.7 ms p95 across twenty isolated `--version` process starts
against a 500 ms budget. A run concurrent with the heavy workspace suite exceeded
the startup budget; measure performance on an otherwise idle runner. Rebuilding
the same native target/source twice produced the identical SHA-256
`70724c7ed29ea6a3a0c18855d98b24a9fe08d3a17474dfa5628645b5749de913`.
This demonstrates repeatability for that workspace/toolchain, not cross-host
reproducibility for every platform.

Executed locally: macOS arm64 and x64 version checks, Linux arm64 and x64 glibc
binaries in pinned distroless containers, and Linux arm64/x64 musl binaries in
Alpine containers with the required `libstdc++` runtime installed. x64 execution on the arm64 host uses emulation. Windows was
cross-compiled but not run locally; native matrix validation is provided by the
candidate workflow. Installer tests verify accepted and tampered bytes. The
Homebrew formula passed `ruby -c`. npm candidates used an explicitly local fixture
scope, passed the Node launcher smoke test and `bun pm pack --ignore-scripts`;
no scope was selected for publication and no package was uploaded.

Before a public release: finish native platform CI, exercise deployed GitHub OAuth
and real configured CI runners, review the signing candidates/provenance, select
npm naming and source distribution licensing, configure protected signing/release
permissions and npm trusted publishers, and explicitly authorize publication.
These external release activities remain deferred. The user explicitly accepted
local validation as the merge gate and authorized merging all six implementation
PRs in dependency order, without waiting for GitHub CI. Release/publication
readiness remains a separate future decision.

GitHub CI blocker observed after opening the final PR: build and validation jobs
failed before any steps started. GitHub's check annotations report that recent
account payments failed or the spending limit must be increased. This affects the
existing Validate/compatibility workflows and the new binary matrix. Hosted/Windows runtime validation remains unexecuted until the account
owner resolves Actions billing/spending settings and reruns those checks. The user
explicitly waived this blocker for merging after local validation. No billing
settings were changed.

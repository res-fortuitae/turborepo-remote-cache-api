# M5 local validation record

Validated on 2026-10-27 with Bun 1.4.3, macOS arm64, and local Docker. No
infrastructure, npm packages, GitHub Releases, Homebrew tap or GHCR images were
published. Publication is deferred by explicit user request.

| Stack layer                     | PR                                                                      | Local evidence                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STV-454 device authorization    | [49](https://github.com/StvyaSharma/turborepo-remote-cache-api/pull/49) | D1/KV-enabled flow, approval/denial audit, polling slow-down and one-time redemption; dashboard build                                                             |
| STV-455 developer tokens        | [50](https://github.com/StvyaSharma/turborepo-remote-cache-api/pull/50) | Real JWT verification, default read scope, write policy/grant checks, live session/grant revocation, TTL and audit redaction                                      |
| STV-453 CLI                     | [51](https://github.com/StvyaSharma/turborepo-remote-cache-api/pull/51) | Effect CLI subprocess account/link/permission/exit-code tests; proxy refresh/upload/HEAD/cleanup tests                                                            |
| STV-456 CI auth                 | [52](https://github.com/StvyaSharma/turborepo-remote-cache-api/pull/52) | Seven subprocess cases for GitLab, CircleCI, Buildkite, Bitbucket, API-key fallback, missing identity and denial                                                  |
| STV-489 doctor                  | [53](https://github.com/StvyaSharma/turborepo-remote-cache-api/pull/53) | Fixed health success/failure, admin/non-admin self-test, real handler/storage round trip, cleanup failure, audit and diagnostic redaction                         |
| STV-488 distribution candidates | final stack layer                                                       | Seven cross-compiled targets, complete SHA-256 verification, compiled CLI integration, Docker, installer tamper test, local npm launcher/pack and Homebrew syntax |

Final workspace `bun run check` and `bun run test` passed (23 check tasks and 40
test tasks). The server suite reported 115 passing tests and 41 environment-gated
skips; no deployed/live suites were claimed. The native compiled CLI separately
passed five account/proxy integration tests with 52 assertions.

All seven targets compile within the 128 MiB binary budget. macOS arm64 measured
71,242,226 bytes with 33.2 ms p95 across twenty isolated `--version` process starts
against a 500 ms budget. A run concurrent with the heavy workspace suite exceeded
the startup budget; measure performance on an otherwise idle runner. Rebuilding
the same native target/source twice produced the identical SHA-256
`20c9f0d463640e7f591ddfa53cc087785f9d95358be020cc946ad4abdf947330`.
This demonstrates repeatability for that workspace/toolchain, not cross-host
reproducibility for every platform.

Executed locally: macOS arm64 and x64 version checks, Linux arm64 and x64 glibc
binaries in pinned distroless containers, and Linux arm64/x64 musl binaries in
Alpine containers. x64 execution on the arm64 host uses emulation. Windows was
cross-compiled but not run locally; native matrix validation is provided by the
candidate workflow. Installer tests verify accepted and tampered bytes. The
Homebrew formula passed `ruby -c`. npm candidates used an explicitly local fixture
scope, passed the Node launcher smoke test and `bun pm pack --ignore-scripts`;
no scope was selected for publication and no package was uploaded.

Before a public release: finish native platform CI, exercise deployed GitHub OAuth
and real configured CI runners, review the signing candidates/provenance, select
npm naming and source distribution licensing, configure protected signing/release
permissions and npm trusted publishers, and explicitly authorize publication.
These external release activities remain deferred. Issues stay In Review while
the implementation PRs await review; this record does not claim they were merged.

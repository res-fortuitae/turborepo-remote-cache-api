# Cache platform threat model and security review (STV-474)

Review date: 2026-10-27. Scope: the cumulative M8/M9 stack through STV-508,
including STV-490 anomaly detection, plus the fixes described below.
Status: review-ready; a maintainer must review this document and the launch gates
before public launch. This records source inspection and local validation, not
an independent penetration test or a deployed-infrastructure assessment.

The categories below use [Microsoft's STRIDE model](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats):
spoofing, tampering, repudiation, information disclosure, denial of service and
elevation of privilege. Controls are tied to repository code and tests so that
future changes can be checked against the same assumptions.

## Assets, actors and trust boundaries

Protect cached build outputs, organization/project boundaries, signing keys,
OAuth credentials, sessions, trust policies, grants, audit evidence and service
availability. Build outputs may contain secrets; never treat cache contents as
public merely because their keys are content hashes.

Untrusted actors include anonymous callers, ordinary users, a different project
or organization, a stolen bearer credential, an untrusted pull request, a
compromised dependency running in a trusted CI job and another process on a
runner. Organization admins can manage their organization's policies. Instance
admins require explicit, time-limited organization elevation for scoped access.
The operator's repository, build pipeline, Cloudflare account, configured CI
issuers and Secrets Store form the trusted computing base. Compromise of that
base requires credential rotation and independent recovery; application RBAC
cannot constrain an attacker who can replace the Worker or signing secret.

The principal boundaries are:

- CI assertion to exchange: an unverified JWT chooses only a registered,
  exactly allowed issuer; signature, audience, claims and atomic replay checks
  establish identity before policy matching and cache-token issuance.
- Cache credential to storage: credential-derived organization/project selects
  the R2 prefix and private edge key. Query selectors can confirm scope but do
  not grant it. Authorization runs before every private edge lookup.
- Browser to management API: signed cookie, live D1 session/user, permission
  check, same-origin mutation protection and optional admin passkey proof.
- Turbo child to local proxy: loopback listener and random per-session secret;
  the proxy owns the CI token and ephemeral DPoP key. The child still receives
  artifact signing material when required by Turbo's signature protocol.
- Mutable stores to audit evidence: transactional audit events and outbox,
  per-chain sequencing, daily locked R2 checkpoints and independent verification.

## Threat/control/evidence register

| Threat and STRIDE category                                                      | Implemented control and source                                                                                                                                                                                                                                                           | Local evidence / remaining limit                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious code in a trusted job (tampering, elevation)                          | [Policy guardrails](../packages/oidc/src/policy-guardrails.ts), read-only developer defaults, [signature envelopes](../packages/credentials/src/artifact-signing.ts), [anomaly detection](anomaly-detection.md), targeted purge                                                          | OIDC guardrail, artifact-signing, anomaly and incident suites. A job that legitimately obtains write access and a shared signing key can still poison its project.                                                                                             |
| Name-only policy, wildcards, `pull_request_target` (spoofing, elevation)        | Immutable provider IDs, exact allowed audiences/issuers, constrained ref patterns and explicit workflow/environment policy in [guardrails](../packages/oidc/src/policy-guardrails.ts) and [matcher](../packages/oidc/src/trust-policy-matcher.ts)                                        | Guardrail/matcher tests cover unsafe and overlapping policies; exchange re-evaluates live ceilings. Safe configuration still needs operator review.                                                                                                            |
| Stolen cache JWT (spoofing)                                                     | [DPoP verifier](../packages/credentials/src/dpop.ts) checks key thumbprint, method, canonical URL, token digest, time and single-use proof; short TTL and [Coordinator epochs](../packages/coordinator/src/client.ts)                                                                    | DPoP and project-cache suites reject proof reuse/wrong binding. Epoch visibility is bounded by the five-second isolate cache. Unbound env mode and API keys remain bearer credentials.                                                                         |
| Other local process abuses proxy (spoofing, disclosure)                         | [CLI proxy](../packages/cli/src/auth.ts) binds `127.0.0.1`, selects an ephemeral port and random secret; [core proxy](../packages/client-core/src/cache-proxy.ts) restricts routes, forwards safe headers and refuses redirects                                                          | Client-core/CLI/Action integration tests. Same-UID/root compromise can inspect processes/files; the secret is not an OS isolation boundary.                                                                                                                    |
| Persistent runner leaks across jobs (disclosure, tampering)                     | Per-job proxy/DPoP key, private credentials/spool files, cleanup, [doctor runner guidance](doctor.md)                                                                                                                                                                                    | CLI, proxy-upload and signature-rotation suites. Use disposable runners; clean workspaces and logs. Persistent same-UID attackers remain a residual risk.                                                                                                      |
| Cross-tenant/project access (disclosure, elevation)                             | [Project cache authorization](../apps/server/src/project-cache.ts), live [authorization service](../packages/authz/src/authorization.ts), tenant/generation-scoped edge keys                                                                                                             | Permission matrix, project-cache and edge-cache suites, including warm entries. Downstream responses now use `no-store` to prevent reuse of a credential-dependent public URL.                                                                                 |
| CI claim confusion/replay (spoofing)                                            | [OIDC verifier](../packages/oidc/src/verifier.ts): algorithm/issuer/audience/lifetime checks, provider profiles and D1 replay claim after successful verification                                                                                                                        | Verifier/exchange/provider suites cover wrong audience/issuer, expiry, concurrency and optional token-ID hashing. Provider identity claims must be normalized before a dimension can be monitored.                                                             |
| JWKS spoofing / issuer SSRF (spoofing, disclosure)                              | [Issuer registry](../packages/oidc/src/issuer-registry.ts) uses fixed vendor hosts. Discovery issuer and HTTPS JWKS origin must match explicit registration; redirects/time/body/key counts are bounded. Custom issuers use operator-pinned public RSA keys and never trigger discovery. | Verifier/custom-issuer tests cover hostile endpoints and keys. Custom names reject IP literals/local suffixes. No DNS-rebinding fetch is possible for a custom issuer because no fetch occurs. Operator key/issuer compromise remains trusted-base compromise. |
| Stale KV authorizes revoked users (elevation)                                   | [Storage ADR](adr/0002-storage-consistency-rules.md); sensitive actions re-read D1, sessions persist in D1, cookie cache disabled, atomic replay in D1, JWT epochs in Coordinator                                                                                                        | Auth/authorization tests cover revoked/expired sessions, bans and grant changes. KV remains a rebuildable JWKS/session/API-key cache with documented staleness; it is not the permission authority.                                                            |
| Exchange/JWKS DoS (denial of service)                                           | [Request guards](../apps/server/src/request-guards.ts), org/IP limits, bounded JSON, five-second JWKS timeout, refresh semaphore and 30-second refresh cooldown                                                                                                                          | Rate-limit/verifier tests; [fleet results](../perf/results/2026-10-27.md). Rate limiting is approximate per location. Sustained multi-location abuse can consume capacity; local load latency misses remain a release gate.                                    |
| Custom-role / instance-admin escalation (elevation)                             | [Organization permission delegation](../packages/auth/src/organization-access.ts), live D1 role/session facts, explicit [instance elevation](../packages/auth/src/instance.ts), last-owner safeguards, bans, impersonation restrictions and optional passkey proof                       | Organization, instance, passkey and exhaustive policy suites. An authorized owner can intentionally grant broad rights; review grants and keep owner access narrow.                                                                                            |
| Audit deletion/modification (repudiation, tampering)                            | [Audit transactions](../packages/audit/src/audit-log.ts), unique chain sequence, outbox delivery and [locked checkpoints/verifier](../packages/audit/src/integrity.ts)                                                                                                                   | Audit integrity tests detect edits, missing rows and broken chains. An attacker with both source-of-truth and independent checkpoint control can defeat evidence. Back up checkpoints separately from operator credentials.                                    |
| Client/distribution compromise (tampering, spoofing)                            | Pinned workflow actions, frozen lockfile, [binary checksums and optional signing](cli-distribution.md), protected tag/environment signing path                                                                                                                                           | Build/distribution tests and locally checked Action bundle. Checksums from the same compromised release source are insufficient; validate provenance/Sigstore identity. Hosted signing/publication was not executed because CI is unavailable.                 |
| Browser XSS, framing, CSRF and cookie leakage (spoofing, disclosure, elevation) | CSP on Worker and assets, nosniff/frame/referrer headers, same-origin management APIs, fixed auth base URL, HttpOnly/Secure/SameSite cookies and explicit Better Auth CSRF checks                                                                                                        | Origin-routing, real emulated GitHub OAuth, management and local asset/CSP tests. See the header review below.                                                                                                                                                 |

## Findings and fixes in this review

**SEC-01 — High: public downstream caching of scoped artifacts.** The URL of an
artifact does not include the credential-selected project. Download responses
previously inherited `public, max-age=3600` from the internal edge cache, allowing
an intermediary to reuse bytes without the application's tenant authorization.
`artifactApi` now sets `Cache-Control: no-store` on all outbound cache responses,
including warm hits, metadata, failures and multipart responses. The private
Workers copy retains its cacheable header and scoped key. A regression test
checks cold/warm headers, internal cacheability, anonymous rejection before a
warm lookup and another team's miss. Existing downstream copies cannot be
recalled by a header change: invalidate any intermediary caches or wait out the
previous one-hour TTL before exposing sensitive clients to the upgraded path.

**SEC-02 — Medium: missing dashboard CSP.** Both dynamic Worker responses and
the assets-first `_headers` path now restrict script and network access to the
same origin, block inline script attributes/eval, objects, base tags and framing,
and restrict forms to the application. GitHub avatars are the only external
image origin. Inline styles remain necessary for the component library; bundled
WOFF2 fonts use `data:` and are explicitly allowed. The production build emits
external same-origin scripts. Local stack assertions verify actual delivered
headers, script origins and asset content types. This is defense in depth, not
a replacement for React escaping or safe URL handling. The policy follows
[OWASP CSP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).

**SEC-03 — Medium: provider OAuth credentials stored without application-level
encryption.** Better Auth's `account.encryptOAuthTokens` is now enabled. The real
GitHub emulator test verifies an encrypted stored access token decrypts to the
provider-issued token, the session still works, and neither token nor ciphertext
is included in audit payloads. The installed Better Auth implementation encrypts
access/refresh tokens; the configured GitHub flow does not issue an ID token.
The setting does not retroactively rewrite older database rows. Existing
installations must revoke pre-upgrade provider tokens and reauthenticate users
before declaring the storage remediation complete, or perform an independently
reviewed controlled encryption migration. Existing backups may still contain the
old material. Preserve the Better Auth secret; rotating it also affects artifact
key envelopes. See [Better Auth's documented option](https://better-auth.com/docs/reference/options#encryptoauthtokens)
and [secret-rotation guidance](https://better-auth.com/docs/reference/security).

**SEC-04 — Dependency advisories.** `bun audit --json` initially reported nine
affected package names. Root overrides now pin patched, same-major versions:
`@hono/node-server` 1.19.17, `@simplewebauthn/server` 13.3.3,
`@vitest/mocker`/`vitest` 4.1.12, `hono` 4.13.14, `lodash` 4.18.1,
`sharp` 0.35.5, `valibot` 1.5.0 and Undici 7.x to 7.30.1. The Undici selector
preserves the separate 6.x/8.x dependents. Hono/Prisma, Vitest, image processing
and much of Undici are transitive local/build tooling; the WebAuthn server is
part of passkey verification. They are patched regardless of exposure.
`bun install --frozen-lockfile` with Bun 1.4.3 validates lockfile v3, and the
post-update registry audit returns `{}`. Keep these overrides until upstream
pins reach safe versions, then remove them with the same checks. Audit results
are a point-in-time registry check, not evidence that unknown vulnerabilities
cannot exist. Representative advisories: [WebAuthn attestation](https://github.com/advisories/GHSA-6hxq-p678-4hr2),
[Lodash template injection](https://github.com/advisories/GHSA-r5fr-rjxr-66jc),
[Undici decoding DoS](https://github.com/advisories/GHSA-xjj6-f33q-929c).

## Headers, credentials and operational assumptions

Cookie configuration explicitly enables origin/CSRF checks even in tests, uses a
fixed canonical base URL, enables Secure cookies on HTTPS, and keeps session
cookies HttpOnly and SameSite=Lax. Sensitive routes re-read D1 instead of trusting
KV session facts. OAuth state/callback origin checks and one-time device-code
consumption are covered by integration tests. The dashboard never persists a
session or provider token in localStorage. Same-origin APIs have no credentialed
cross-origin grant; Turbo preflight and the authenticated loopback proxy's
preflight are deliberately separate from browser management CORS.

Secrets remain in root ignored environment files/Secrets Store, not organization
config. Artifact keys are envelope-encrypted with authenticated tenant/key IDs.
Access tokens and signing material are redacted at service boundaries; audit
snapshots allow only bounded verified claim fields, never raw bearer/proof
strings. Explicit CLI env mode intentionally prints credentials and is less
isolated than proxy mode. The proxy must not follow redirects or forward session
cookies. Root/same-UID compromise can still recover process memory and temporary
files; neither DPoP nor a loopback password protects a hostile runner host.
[RFC 9449's client security considerations](https://datatracker.ietf.org/doc/html/rfc9449#section-11.4)
explain why possession binding does not make untrusted client execution safe.

Anomaly detection is alert-only by default. Operators must deliberately enable
read-only/revocation containment. First-seen baselines can be trained by a
compromised first job; normal workflow changes can trigger false positives.
Hourly statistical checks are not instantaneous; the workflow exchange rule and
write fence are the near-real-time path. Background observation failures can
leave gaps. Revoke-only mode allows newly issued credentials after the bump;
combine it with read-only mode for sustained quarantine. In-flight writes may
finish after their final check. HMAC artifact signatures cannot distinguish two
holders of the same signing key. These are accepted design limits, not claims
that poisoned trusted builds are prevented.

## Validation and launch gates

Local evidence is recorded with the PR and [performance report](../perf/results/2026-10-27.md).
Run the following after security-sensitive changes:

```sh
bun install --frozen-lockfile
bun audit --json
bun run check
bun run test
bun run test:stack
bun run perf:smoke
bun run perf:exchange
bun run perf:proxy
bun run perf:local
```

`test:stack` builds the dashboard and uses local Alchemy/workerd only. The local
legacy fixture is enabled solely when both test/dev flags equal `1`; normal
operator config and deployed stages keep their explicit legacy flag. New tests
cover outbound cache isolation, actual served CSP and encrypted GitHub token
persistence, complementing the existing permission/replay/admin/audit suites.
GitHub CI is not relied upon. No live issuer, Cloudflare deployment, release
publication, hosted signing or cross-platform runner was exercised here.

Before launch, a maintainer must review the fixes and residual risks, privately
claim the first instance owner before opening OAuth to other users, keep legacy
shared-token mode disabled after migration, complete the SEC-03 existing-data
remediation if upgrading, and invalidate/wait out SEC-01 old downstream copies.
Run the enforcing staging load gate from a separate load generator: local mixed
200-job latency targets missed, and deployed SLOs remain unverified. Exercise
real configured CI issuers, passkeys and alert delivery on that authorized stage.
Verify signed client provenance when hosted release signing becomes available.
These deployment/operational gates are intentionally not labeled completed by
local source tests or by opening this PR.

Model: gpt-6.1-sol · Agent: Codex · Harness: T3 Code/Codex · Timestamp: 2026-10-27T10:42:02Z

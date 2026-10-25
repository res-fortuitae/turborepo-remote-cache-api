# OIDC verification

`OidcVerifierLive` verifies a CI ID token and consumes its replay ID. It requires
an Effect `HttpClient`, `JwksCache`, `IssuerRegistry`, `ReplayGuard`, `OidcAudience`
and `OidcVerifierConfig`. The exchange route and trust-policy matching are separate
work in STV-449 and STV-447. A verified identity still needs authorization before
the exchange can issue a cache token.

`GitHubIssuerRegistry` permits GitHub Actions' canonical issuer
`https://token.actions.githubusercontent.com` and GitHub Enterprise Cloud's
`https://token.actions.githubusercontent.com/<enterpriseSlug>` variant. Every
issuer also needs an **exact** entry in the instance's `allowedIssuers` list;
`OidcVerifierDefaults` enables only the canonical issuer. An empty list disables
verification. Additional providers, including self-hosted GitHub Enterprise,
need an explicit registry implementation with trusted key origins and algorithms.
Unregistered token issuers never cause outbound requests.

The verifier requires `sub`, `jti`, `iat`, `nbf`, and `exp`, an exact issuer, and
at least one exact match with the configured CI audiences. These are independent
of the audience on cache tokens issued by this service. The result preserves
provider claims and reports the exact matched audience for policy matching and
audit provenance. GitHub signatures must use RS256. Unsigned and symmetric
algorithms, token-supplied key URLs, and embedded keys cannot select trusted keys.

Defaults are a maximum age of 600 seconds and 30 seconds of clock tolerance.
Tokens must also have `exp > iat`, `nbf < exp`, integer temporal claims, and a
declared lifetime no greater than the configured maximum age. Configuration caps
maximum age at one hour and tolerance at 60 seconds. Inputs over 16 KiB and key
IDs/replay IDs over 256 characters are rejected. Failures contain a reason, never
the raw token. Database failures remain typed `DatabaseError` failures and must
fail the exchange closed.

## Discovery and key caching

Discovery uses the issuer's `/.well-known/openid-configuration`. Its issuer must
match exactly; `jwks_uri` must use HTTPS and a registry-approved origin, without
credentials or a fragment. Each response stream is limited to 64 KiB, and the
complete discovery/key fetch has a five-second timeout. The fetch transport uses
manual redirects and omits credentials. Inject an HTTP client without
redirect-following middleware.

`JwksCacheLive` uses the rebuildable KV cache; `JwksCacheTest` uses in-memory KV.
The verifier retains keys and imported public-key resolvers in its layer for one
hour. Reuse that layer within an isolate to retain its cache and cooldown state.
Unknown key IDs can force a refresh, at most once per issuer per 30 seconds per
verifier layer. Failed network attempts count against the cooldown. Concurrent
loads are coalesced; key refresh limits are local, not globally coordinated.
KV errors fall back to the issuer, and cached key sets are subject to the same
public-key restrictions as network results. Briefly stale public keys are
expected; replay protection never depends on KV.

## Replay protection and cleanup

After all signature and claim checks, `ReplayGuardLive` atomically claims the
existing D1 `(issuer, jti)` unique key. Independent verifier instances sharing D1
cannot both accept the same ID. The key is deliberately independent of audience
or token expiry, so changing those claims cannot reuse an unexpired ID. No schema
migration is needed. A successful verification consumes the token even if later
authorization or token issuance fails; CI must request a fresh ID token to retry.

Expiry is stored in **milliseconds**, including the clock-tolerance window.
`pruneOidcReplayIds` deletes only rows whose full acceptance window has ended.
The Worker runs it hourly at minute 13 UTC and logs job failures. Deployment of
that schedule occurs through the normal root deploy command.

`bun run --cwd packages/oidc test` runs signed fixture, mutation, rotation,
discovery, transport-bound, clock, and concurrent replay tests without network
or credentials. The shared replay repository is additionally tested against
SQLite and local workerd D1 in `@repo/db`.

## Trust policies

`TrustPolicyMatcherLive` (or the identical, stateless `TrustPolicyMatcherTest`)
provides `TrustPolicyMatcher.match(project, policies, claims)`. Pass only claims
already verified by `OidcVerifier`. Matching performs no network access and does
not consume replay IDs, issue tokens, or write audit records.

Policies retain the [OIDC UI shape](https://ui.shadcn.com/oidc/docs/save-and-verify):
`issuer`, `claims`, and optional `label`, with `scope`, `ttlSeconds`, optional
`refPatterns`, and optional `requireBoundTokens`. Issuers must use HTTPS without
credentials, query or fragment. Every claim rule must have nonempty string values;
`aud` is required. TTL is an integer between 1 and 3600 seconds; the exchange must
also enforce instance/org ceilings and the incoming token lifetime.

The issuer and every configured claim match exactly, including case. Scalar claims
and array claims match if at least one string equals an allowed value. `*` in an
ordinary claim is a literal. Optional `refPatterns` adds an AND constraint: at least
one pattern must match a string `ref` or `branch` claim. Only `*` (any sequence)
and `?` (one character) are special, including across `/`; an empty pattern list
matches nothing. Pattern warnings and provider-specific guardrails follow in STV-487.

Only enabled policies belonging to the requested project participate. All matches
combine into the most restrictive scope, shortest TTL, and binding required if any
match requires it. Archived projects force read-only; a deleted project never
matches. Denials return the closest policy ID and failed rule names (first policy
wins ties), without claim values. STV-449 consumes these diagnostics for denial audit
and returns 403; HTTP exchange is not implemented by the matcher.

### Policy guardrails and simulation

`PolicyGuardrailsLive` / `PolicyGuardrailsTest` expose pure `evaluate(policy,
settings)` and `test(project, policies, sampleClaims, settings)` methods. Callers
supply the deployment audiences and effective instance/org policy on each call.
The tester excludes policies with hard errors and returns individual rule results,
warning/error codes, matching IDs, and the restrictive resulting scope/TTL. Samples
are **unverified simulations**: the tester never authenticates a workload, fetches
keys, consumes replay IDs, signs tokens, or changes policies.

Saves require immutable GitHub `repository_id` + `repository_owner_id`, Vercel
`owner_id` + `project_id`, or GitLab `project_id` + `namespace_id`. GitHub/GitLab IDs
must be numeric. Every audience must be in the deployment's accepted audience list,
and issuers must be in the effective allowlist. All claim values are exact: `*` and
`?` are rejected outside `refPatterns`. Other providers fail closed until STV-451
adds their immutable identity profiles; registering a verifier alone cannot bypass
these checks.

GitHub write policies must restrict `event_name` to `push`, `workflow_dispatch`, or
`schedule`; Vercel writes require exactly `environment=production`; GitLab writes
must restrict `pipeline_source` to `push`, `web`, or `schedule`. Broader event
policies, fork/PR subjects and preview deployments require the explicit policy
flag `allowUntrustedWrites=true` and always produce a warning. This is a deliberate
security override, recorded with policy mutations in audit metadata. Without it,
the matcher also caps legacy policies to read on PR/target-PR, fork, GitLab merge
request, or preview claims. A read policy always keeps an overlapping decision
read-only, including when another policy has the override.

Warnings identify wildcard write refs, writes without a workflow/environment
restriction, and TTLs at least 80% of the effective maximum. TTLs over the maximum
are refused. `requireBoundTokens` in effective instance/org policy must also be
present on saved policies. Instance/org `oidcWriteWorkflowRefs` and
`oidcWriteEnvironments` allowlists require exact restrictions on write policies;
organizations may narrow but cannot clear or broaden parent restrictions. Admins
must select environments with protection rules in their CI provider; saving a
policy does not query that provider's protection settings.

Future exchange handlers must evaluate guardrails with the current effective
settings before matching, so legacy policies and tightened settings fail closed.
The tester demonstrates that composition. Signature, audience, expiry and replay
verification remain mandatory before any real exchange.

## CI exchange

`POST /oidc/exchange` accepts `{ token, team, project }`, where `team` and `project`
are immutable organization/project IDs. No browser session is needed. The endpoint
is mounted by the Worker; `OidcExchangeLive` owns the use case and receives verifier,
matcher, guardrails, signer, audit, repositories and rate limiting as Effect services.

Only enabled policies on the requested project can grant access. Current instance,
organization and deployment ceilings are applied on every exchange. Invalid legacy
policies fail closed; archived projects issue read-only tokens, deleted projects
and archived organizations cannot exchange. The signed cache JWT contains current
Coordinator revocation epochs. Its TTL is the minimum of matching policies, current
instance/org maximum, signer maximum and remaining CI-token life plus a 30-second
skew margin. The response matches `ExchangeResponse`: redacted token on the client,
ISO `expiresAt`, canonical `api`, organization/project IDs and effective scope.

Every POST attempt, including malformed input, replay, rate limiting and denials,
is recorded durably in the audit log before returning. Claim snapshots contain only
an allowlist of verified identity/context claims, never raw tokens, proofs or unknown
custom claims. Denials expose a generic 403; nearest-policy/failed-claim and guardrail
details stay in audit metadata. Limiter rejection returns 429 with Retry-After;
service/audit failure returns 503. All responses use `Cache-Control: no-store`.
Bodies are stream-bounded to 24 KiB, individual CI tokens to 16 KiB and IDs to 256
characters. The native Rate Limiting binding uses separate `oidc:ip:` and `oidc:org:`
keys (edge-local approximate protection, not an exact global quota).

DPoP verification/binding follows in STV-486: a supplied proof or any binding
requirement is rejected until then, never downgraded to bearer. Signature-key delivery
follows STV-475; mandatory artifact signing also fails closed until available.
`ExchangeConfig` carries deployment identity ceilings; hosts must supply real rate
limits. No infrastructure is provisioned by this service or its tests.

## Use the cache from Vercel builds

`BuiltinIssuerRegistry` adds Vercel team (`https://oidc.vercel.com/<team-slug>`)
and global (`https://oidc.vercel.com`) modes to GitHub. The Worker uses it; the
GitHub-only layer remains available. Registration does not change instance defaults:
add the exact issuer to the effective `allowedOidcIssuers` policy. Discovery and
JWKS stay on `https://oidc.vercel.com`, with RS256 signatures only.

Vercel claims are schema-validated after signature verification: `owner`,
`owner_id` (`team_…`), `project`, `project_id` (`prj_…`) and `environment`.
Policies must bind immutable owner/project IDs and the API audience. Use production
for read/write, preview for read-only. Slugs in `sub` change on rename; immutable
IDs keep policy identity stable, but a team-mode issuer rename requires a new exact
allowlist entry. Never replace ID conditions with slug-only conditions.

The client reads the current header, configured token file, or build's
`VERCEL_OIDC_TOKEN`, in that order, on every acquisition. It then calls Vercel's
fixed audience exchange endpoint with the API audience and a fresh `jti`. The
[SDK implementation](https://github.com/vercel/vercel/blob/main/packages/oidc/src/exchange-vercel-oidc-token.ts)
uses the same JSON protocol in builds and Functions. The original default audience
is not sent to our cache or automatically trusted. Source and exchanged credentials
are masked. Provider responses are stream-bounded, redirects disabled, no retries.

[Vercel documents](https://vercel.com/docs/oidc/reference) build tokens lasting one
hour and Function tokens two hours. Its custom-audience exchange resets `iat` and
preserves expiration. This profile therefore bounds declared lifetime to two hours
while preserving the independent 600-second maximum age, expiry/skew checks and
atomic replay enforcement. A missing `jti` is refused: the client always requests
one. Development tokens with a remaining lifetime over two hours are refused.
Cache JWT TTL still uses the normal live policy/instance/signer ceiling.

When STV-485 supplies the CLI wrapper, configure the build command as
`tcache exec -- turbo run build`, with API/team/project configuration. Until then,
hosts can compose `ClientCoreLive` as documented in `@repo/client-core`; the CLI
command is not implemented by this issuer change. Refresh rereads the source and
requests a new assertion; expiry of a fixed source cannot be repaired by reusing it.

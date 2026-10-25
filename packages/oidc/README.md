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

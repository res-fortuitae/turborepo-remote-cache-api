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

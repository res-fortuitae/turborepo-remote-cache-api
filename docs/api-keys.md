# Organization-owned API keys

Static keys are a **less secure fallback** for CI systems that cannot use OIDC.
Prefer short-lived cache JWTs obtained through trusted CI. This implements
STV-443; the Bearer credential resolver and cache-route integration follow in
STV-445, and the credentials dashboard follows in STV-470.

Keys belong to an organization, survive the creating user's departure, and grant
access to exactly one project in that organization. Org owners/admins and custom
roles with `apiKey.create` can issue them; `apiKey.revoke` can list and revoke them.
Management requires a live, unbanned session confirmed in D1 and a trusted Origin.

All management routes use `POST`, JSON, and the existing session cookie:

- `/api/auth/cache-keys/create`: `{ "organizationId": "org-id", "name": "Jenkins", "permissions": { "project": ["project-id"], "cache": ["read"] }, "expiresIn": 2592000 }`
- `/api/auth/cache-keys/list`: `{ "organizationId": "org-id" }`
- `/api/auth/cache-keys/revoke`: `{ "keyId": "key-id", "emergency": false }`

Omit `cache` to default to `read`. The only other scope is `["read", "write"]`.
Omit `expiresIn` for 30 days, lowered to the effective instance/org ceiling when
necessary. Zero, null, non-integral, negative and over-ceiling lifetimes are rejected;
90 days is an unconditional hard cap. The `tcache_` prefix is fixed. Creation
returns the secret once with `Cache-Control: no-store` and a `Warning: 299` header;
list responses never return the secret or its hash. Clients must store it securely.
Stock `/api/auth/api-key/*` HTTP management endpoints are disabled so plugin
options cannot bypass these constraints. API keys never create login sessions.

The plugin handles generation and hashing in D1. A separate audited companion row
holds project/organization epoch stamps and sampled usage. Creation/revocation
records contain IDs, never key material. The application exposes `ApiKeyLookup`
from auth; credentials adapts it to `ApiKeyVerifier` without importing Better Auth.
Cache responses should use the exported `API_KEY_WARNING` when STV-445 integrates
this verifier. The instance/org `apiKeys` policy is enforced both at issuance and
verification; org policy can only tighten the instance policy.

Verification uses 60-second KV projections for key metadata and policy. Cache
misses rebuild from D1; warm requests perform no D1 lookup. Verification does not
call the plugin's verifier, which updates `lastRequest` even with rate limiting
disabled in Better Auth 1.7.12. Plugin `remaining`, refill, request-count and
last-request fields are untouched. Rate limits belong to the Workers binding
(STV-446). A KV marker schedules background `lastUsedAt` updates at most once a
minute per location; a conditional D1 update prevents concurrent locations from
recording usage more than once a minute. This is sampling, not a usage ledger.

Normal revocation disables D1 and deletes its KV projection; remote locations can
retain access for approximately 60 seconds. Policy changes have the same cache
window. Emergency revocation first bumps the project's Coordinator epoch, then
disables the key. The API-key adapter reads epochs directly on each verification,
without the JWT client's five-second epoch cache, so stale KV key projections are
rejected immediately after the bump. All previously issued project keys become
invalid; issue replacements after the incident. The later cache resolver must
also enforce current organization/project authorization.

A daily 04:43 UTC job persists owner notifications and sends mail when available.
It includes keys expiring within seven days or unused for fourteen days (including
never-used keys older than fourteen days), excluding disabled/expired keys. The
job scans bounded pages and contains IDs/names and timestamps, never secrets.
Mail-disabled instances retain notifications in the console.

The additive migration creates the plugin's `apikey` table and `cache_api_key`.
Apply it through the normal root deployment workflow; this PR does not deploy.
GitHub secret-scanning prefix registration remains M9 work.

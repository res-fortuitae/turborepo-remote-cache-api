# Request guards

`@repo/ratelimit` owns the `RateLimiter` Effect service, its Workers binding port,
an in-memory test layer, and Better Auth's atomic `consume` adapter. Production
counts use Workers Rate Limiting bindings, never KV or D1 counters. Counts are
approximate and local to each Cloudflare location; they are abuse protection,
not the strict D1 usage quotas planned in STV-476.

## Budgets and responses

| Traffic                                            | Counter identity                         | Default budget                                                      |
| -------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Authorized cache requests (JWT and API key)        | Credential type and credential ID        | 600 per 60 seconds                                                  |
| Invalid cache authentication                       | Trusted connecting IP                    | 30 failures per 60 seconds                                          |
| Better Auth, including custom cache-key management | Trusted connecting IP, across auth paths | 60 per 60 seconds                                                   |
| Better Auth endpoint rules                         | Better Auth's IP/path key                | Existing endpoint/plugin rules, rounded down to a binding threshold |
| `/oidc/exchange`                                   | Trusted connecting IP                    | 30 per 60 seconds                                                   |

Every counter key includes the canonical instance origin, deployment stage, and
budget name. Raw bearer secrets are never counter keys. All cache routes share a
credential's budget, including status, events and metadata queries. Upload
reauthorization does not charge twice. Legacy migration traffic shares one
credential budget. OPTIONS preflights do not consume cache budgets.

IP guards trust only `CF-Connecting-IP`, which Cloudflare overwrites. Changing
`X-Forwarded-For` does not change the budget. Missing trusted IPs share an
`unknown` bucket; Better Auth uses its equivalent shared fallback per path.
The OIDC exchange guard is wired to the reserved exchange route; implementing
the exchange itself remains STV-449.

Exhausted budgets return HTTP 429 with `Retry-After` in seconds. The binding does
not expose the exact remaining window, so the delay is a conservative full
10- or 60-second period. Better Auth's `X-Retry-After` is retained and copied to
`Retry-After`. Cache/auth IP binding outages fail closed with 503; a failure inside
Better Auth's endpoint hook fails the auth request rather than bypassing limits.

## Organization settings and deployment ceilings

The existing instance and organization policy APIs accept:

- `cacheRequestsPerMinute`: one of `10`, `30`, `60`, `100`, `300`, `600`.
- `maxQueryHashes`: positive integer, default `100`, hard maximum `1000`.

Organization settings can only tighten instance settings. The root
`deploy.config.ts` can additionally set `identityCeilings.maxCacheRequestsPerMinute`
and `identityCeilings.maxQueryHashes`. Existing stored policies without these
fields retain the defaults. Policy changes use the same counter keys and
namespace across tiers, so switching tiers does not intentionally reset counts.

Workers bindings have fixed thresholds. The Worker binds thresholds
`1, 3, 10, 30, 60, 100, 300, 600` for both supported periods. Period-60 bindings
share account namespace `4280` (including the existing `RATE_LIMITER` binding);
period-10 bindings share namespace `4281`. Other uses in the same account should
reserve different namespace IDs. Better Auth rules select the nearest lower
threshold and the nearest supported longer period, preserving or tightening
protection. Unsupported windows longer than 60 seconds fail closed.

`POST /v8/artifacts` rejects a batch above the effective hash count before any
artifact lookup; the shared wire schema rejects more than 1000 hashes. Per-entry
invalid hash errors remain supported. PUT checks the project's effective byte
limit against `Content-Length` before streaming to R2, retaining the existing
project, instance and deployment upload ceilings.

## Better Auth storage

`AuthLive` requires `RateLimiter`. Its custom storage implements the pinned
Better Auth version's atomic `consume` method. The API-key plugin's per-key
storage limiter remains disabled. Session caching stays in KV with authoritative
D1 session checks; neither receives rate-limit counter writes. The existing D1
`rate_limit` table is retained for additive schema compatibility and schema
generation, but runtime authentication does not use it for counters.

Tests use `RateLimiterTest` with fresh counters per layer build and Effect's
`TestClock`; no Cloudflare account or deployment is required.

### Artifact input limits

Artifact query JSON is streamed with a 100,000-byte cap; cache event JSON has a
1,000,000-byte cap. Exceeding either returns 413 and stops reading the stream.
Queries allow at most 1,000 hashes (or the lower project policy limit), each at
most 256 characters. Invalid hex query entries retain per-entry errors.
Events allow at most 1,000 entries, with session IDs and hashes limited to 256
characters and optional duration between zero and 86,400,000 milliseconds.
These are resource ceilings; client-reported analytics remain untrusted and
replays can still inflate counters.

Direct and multipart artifact hashes accept 1–256 hexadecimal characters and
use lowercase storage keys. Existing uppercase keys are not migrated or read as
fallbacks: they become cold misses and expire under retention. Direct PUT and
multipart creation reject custom metadata exceeding 6,000 UTF-8 bytes of JSON,
including server provenance and upload session, with 400. This includes duration,
tag, SHA and dirty-hash headers. Direct upload and multipart part byte ceilings
continue to apply independently.

The compatibility tests exercise real Turbo 1.13.4, 2.10.13 and 2.11.10 payloads;
these ceilings deliberately allow far more than their small fixture batches and
16-character task hashes. They are resource limits, not a claim about the largest
possible Turbo workspace. Operators with larger clients should split batches.

---
status: accepted
---

# Storage consistency rules: KV, D1, Durable Objects, R2

**KV is a cache, D1 is the source of truth, Durable Objects handle anything atomic or
immediately effective, and R2 holds blobs.** Pick a store by the consistency a value
needs, not by read speed. This decision implements
[STV-483](https://linear.app/stvyas-workspace/issue/STV-483).

## Why KV is only a cache

Workers KV is eventually consistent: a write can take about 60 seconds to reach other
locations. It has no atomic operations (no compare-and-set, no increment), allows about
one write per second to the same key, and stores values up to 25 MiB. So a KV value
may be stale, may lose a concurrent update, and can't take hot per-request writes.

Every KV value must therefore be rebuildable from D1, R2, or an upstream source, and a
stale read must be harmless or bounded by a documented lag. If a stale or lost write
would be a security or correctness bug, the value doesn't belong in KV.

## Store ownership

Each store is reached only through a service tag in its owning package (see
[ADR 0001](./0001-package-boundaries-and-effect-layers.md)):

| Store          | Owner                                                                       | Infra declaration   |
| -------------- | --------------------------------------------------------------------------- | ------------------- |
| D1             | `@repo/db`                                                                  | `Database`          |
| Durable Object | `@repo/coordinator`                                                         | `Coordinator` class |
| R2             | `@repo/artifacts`                                                           | `ArtifactBucket`    |
| KV             | small cache services (`JwksCache` in `@repo/oidc`, auth `SecondaryStorage`) | `CacheNamespace`    |

## Where each kind of data lives

| Use                                          | Store                                                                                              | Why                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifacts                                    | **R2** + Workers Cache API                                                                         | Values over 25 MiB and the write rate rule out KV. turborepo-remote-cache-cloudflare offered KV storage; we don't.                                                                    |
| better-auth sessions                         | KV secondary storage **+** `storeSessionInDatabase: true`                                          | KV gives fast reads. Sensitive actions (admin changes, elevation, token issue) check the D1 session, because KV revocation can lag.                                                   |
| better-auth rate limiting                    | **Workers Rate Limiting binding** (or a DO)                                                        | KV counters aren't atomic and would exceed the per-key write limit.                                                                                                                   |
| API key lookups                              | KV secondary storage, **no per-request writes**                                                    | Turn off per-key `rateLimit`, remaining counts and per-verify `lastRequest`. Record `lastUsed` at most once a minute in the background. Revocation can lag up to 60 s; document this. |
| Device-auth codes                            | **D1**                                                                                             | The browser approves in one location while the CLI polls from another.                                                                                                                |
| GitHub/OIDC JWKS cache                       | KV                                                                                                 | Read-heavy and rarely changes; refetchable from the issuer.                                                                                                                           |
| OIDC `jti` replay protection                 | **D1 unique insert** (or a DO)                                                                     | Needs an atomic "insert if not already present".                                                                                                                                      |
| Cache-JWT revocation                         | Short TTL + **revocation epoch per org/project in the Coordinator DO**, cached briefly per isolate | Emergency revocation must take effect immediately; KV lag would outlast the token.                                                                                                    |
| Audit hash-chain sequencing                  | D1 conditional insert or a **DO per chain**                                                        | Writes to one chain must be serialized ([STV-482](https://linear.app/stvyas-workspace/issue/STV-482)).                                                                                |
| Live counters                                | **DO** or Workers Analytics Engine                                                                 | KV can't increment atomically.                                                                                                                                                        |
| Analytics drill-down results, first-hit flag | KV                                                                                                 | A briefly stale cache is fine.                                                                                                                                                        |

## Implementation

**Coordinator Durable Object.** `@repo/coordinator` exports the `Coordinator` class,
which is bound to the Worker and deployed by the root Alchemy stack. Domain code uses
`CoordinatorClient` (`CoordinatorClientLive` needs `CoordinatorNamespace`;
the Worker host provides `CoordinatorNamespaceLive`, and tests use `CoordinatorClientTest`).
Each scope maps to one instance, addressed by name. An instance handles requests
one at a time, so the read-modify-writes inside it are atomic:

- `revocationEpoch(scope)` / `isRevoked(scope, issuedEpoch)` / `revokeAll(scope)`, with
  scopes like `org:<id>` or `project:<id>`. Each isolate caches an epoch for
  `EPOCH_CACHE_MILLIS` (5 s). A `revokeAll` takes effect immediately in its own
  isolate and in every other isolate within 5 s.
- `chainHead(chain)` / `advanceChain(chain, expectedSequence, hash)`: a
  compare-and-set on the chain head. A writer that loses the race re-reads the head,
  rehashes and retries.

**OIDC replay protection.** `@repo/db` exports `ReplayGuard`. `claim(issuer, jti,
expiresAt, now)` is a single `INSERT … ON CONFLICT DO UPDATE … WHERE expired` on
`oidc_jti`, so two concurrent claims can't both succeed. `purgeExpired(now)` bounds the
table's size.

**KV caches.** `@repo/oidc` owns the `KvNamespace` tag and `JwksCache`. KV read or
write failures and corrupt values count as a miss and fall back to the issuer; an
unknown `kid` calls `refresh`. Auth's `SecondaryStorage` reuses the same rules when
STV-432 adds it.

Device-auth codes live in better-auth's D1 tables (STV-432). Sessions, API keys and
rate limiting follow the table above when their issues configure better-auth.

## Consequences

- Reviewers reject new KV writes that need atomicity, read-your-write across
  locations, or more than about one write per second per key.
- Features that tolerate KV lag (API key revocation, session revocation for
  non-sensitive actions) state the bound in user-facing docs.
- Changing a row in the table above means revising this ADR.

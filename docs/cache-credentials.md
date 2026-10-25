# Cache API credentials

All `/v8/artifacts` endpoints resolve `Authorization: Bearer <credential>` through
`@repo/credentials` before authorization or cache lookup:

- Signed cache JWTs use `CacheTokenVerifier` (signature, issuer/audience, expiry,
  revocation epochs).
- `tcache_` keys use `ApiKeyVerifier` and the organization-owned
  [API-key fallback](api-keys.md). Successful responses, including edge-cache hits,
  carry the less-secure `Warning` header. The header is added after cache lookup;
  it is never persisted in an artifact cache entry.
- Missing, malformed, expired, revoked, and unknown credentials return 401.
  Unavailable JWT verification infrastructure returns 500; API-key lookup failures
  fail closed as invalid credentials. Valid credentials denied by
  project state, policy, scope, or tenant selectors return 403.

`CredentialResolver` returns organization/project IDs, scopes, credential type and
ID, subject, and the verified principal. The cache routes feed that principal to
`Authorization`. PUT needs `write`; status, HEAD, GET, metadata POST, and events
POST need `read`. Status currently reports `enabled` after successful authorization;
quota status reporting follows the quota service.

The credential selects storage: `{orgId}/{projectId}/{hash}`. Optional `teamId`
must equal the organization ID; optional `slug` must equal its current slug.
Every occurrence is checked, including duplicate query parameters. Omit these
selectors when the client supports doing so. Project slugs never select a project.
The synthetic edge-cache URL encodes the complete organization/project prefix;
identical hashes in different projects cannot share an entry. Authorization runs
before warm-cache hits. Uploads recheck authorization before completion and remove
the uploaded object if a racing deletion/archive denies the write.

Use a scoped key or issued cache JWT as `TURBO_TOKEN`, the Worker origin as
`TURBO_API`, and the organization's slug as `TURBO_TEAM`:

```sh
export TURBO_API=https://cache.example.com
export TURBO_TOKEN='<cache JWT or tcache_ key>'
export TURBO_TEAM=acme
bunx turbo run build
```

API-key creation is available through the authenticated management API. JWT issuance
is available as a domain service; the CI exchange endpoint follows in STV-449.
Interactive `turbo login/link` is not implemented.

## Legacy migration flag

Shared `TURBO_TOKEN` cache access is **disabled by default**. Existing operators who
need their previous team namespaces can explicitly set this in `deploy.config.ts`
before their next authorized deployment:

```ts
features: { edgeCache: true, legacyToken: true }
```

The shared secret then retains full read/write access to legacy
`<teamId|slug|default>/<hash>` prefixes. It has no project policy or scope checks.
This is temporary migration access: disable the flag once clients use scoped
credentials. Existing objects are not moved into project prefixes. Recognized JWTs
and `tcache_` keys always use their verifier and never fall back to the shared token,
even if the configured shared secret has that shape. Legacy resolver results use
synthetic `legacy` identity fields; only the migration route selects its old team
prefix.

The instance capability/doctor bearer remains a separate use of `TURBO_TOKEN`.
Disabling legacy cache access does not change doctor authentication.

## Services and verification

`ArtifactStore` and `EdgeCache` in `@repo/artifacts` own bucket operations and cache
keys. Hosts inject `R2Bucket` and `ArtifactCacheStorage`; domains never discover
global bindings. Cache failures fall back to the bucket, and residency restrictions
continue to disable the edge cache. Named Test layers use fresh in-memory stores.

Client-reported events go through `AnalyticsEmitter` with the verified org/project.
Server-observed operation results go through the separate `ArtifactOpEmitter` port,
currently disabled pending M7 persistence. Authorization and tenant denials go
through `AuthorizationAudit` to `AuditLog`; authentication denials use an instance
AuditLog event without copying bearer credentials or query strings. Audit delivery
failures fail closed.

`bun run test` covers resolver failures, both credential types across all operations,
project isolation on warm cache entries, deletion/authorization races, and real
Turbo upload/restore round trips with JWTs and API keys. The shared live/stack suites
still exercise legacy team namespaces; explicitly enable `features.legacyToken`
when running those suites against a running stack.

## Purging edge copies

Scoped downloads use `/{orgId}/{projectId}/g{generation}/{hash}` in the Workers
Cache. The Coordinator stores generation beside the project's revocation epoch;
JWT verification and cache routing share the same read. Clients cache that pair
for five seconds. A generation bump is immediately visible to the client making
it and reaches other clients after their five-second snapshot expires. An
unavailable Coordinator fails authorization rather than serving an expired
snapshot. Requests already in flight can finish under their original generation.

`ArtifactPurger.remove(orgId, projectId, hash)` deletes durable bytes before
bumping the generation. `ArtifactPurger.invalidate(projectId)` is the shared
hook for batch/project purges and future incident/anomaly handlers: call it after
durable removal and before acknowledging success. A failed bump fails the purge;
retry the operation. Every hash in that project's old generation becomes
unreachable, while old edge entries expire naturally. Other projects and
credential revocation epochs are unaffected. The project-deletion maintenance
adapter also bumps generation when revoking the deleted project's credentials.
Legacy migration namespaces retain generation zero; incident purge flows must use
scoped credentials. Residency-disabled caching remains disabled.

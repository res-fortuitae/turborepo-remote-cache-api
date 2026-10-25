# Project management

`@repo/projects` owns project CRUD, grants and maintenance. Changes and their
audit events commit atomically in D1. `@repo/authz` makes live permission decisions;
see [authorization](authorization.md).

Session routes require a live Better Auth cookie. Mutations require the canonical
Origin and at most 16 KiB of JSON. Responses use `Cache-Control: no-store`.

| Route                                                     | Behavior                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| POST `/orgs/:id/projects`                                 | Create (201)                                                 |
| GET `/orgs/:id/projects?limit=50&cursor=...`              | Stable ID pagination, maximum 100                            |
| GET `/projects/:id`                                       | Read                                                         |
| PATCH `/projects/:id`                                     | Rename, limits, description, archive/restore                 |
| DELETE `/projects/:id`                                    | `{ "confirmation": "<project-id>" }`; enqueue deletion (202) |
| GET/POST `/projects/:id/grants`                           | List/upsert same-org user/team grants                        |
| DELETE `/projects/:id/grants/:principalType/:principalId` | Remove grant (204)                                           |

Slugs are unique per organization, lowercase alphanumeric with single hyphens,
maximum 64 characters. Names are nonblank, maximum 100; descriptions maximum 2000.
IDs remain stable through renames. Retention and artifact size are clamped to live
instance/org policy and deployment limits. Passkey step-up applies when required.

Direct and team grants combine by strongest role: project admin, cache write,
cache read. Current organization membership is mandatory. Org owners/admins
implicitly administer projects. Instance roles require a session-bound elevation
to gain organization powers. Denials are audited and audit failure closes access.

## Storage and credentials

Verified cache JWTs choose `{orgId}/{projectId}/{hash}` from their signed claims.
Query parameters can only confirm the org ID (`teamId`) or immutable org slug
(`slug`); mismatches return 403. Identical hashes in separate projects remain
separate objects. Tokens must obey current TTL, signing and binding policy. The
exchange/CLI/API-key issuance paths remain separate M3 work. The signing secret
must contain the `SigningKeySet` JSON described by `@repo/credentials`, and issued
lifetimes must obey the current policy (900 seconds by default).

Archive denies PUT with 403 while reads continue. Delete atomically persists a
permanent tombstone, archives the project and disables trust policies. All project
credentials fail immediately, including API-key principals when M3 adds issuance.
The maintenance cron revokes the project's JWT epoch and deletes up to 1000 R2
objects per tick. It resumes persisted cursors after failures, then removes grants,
policies, rollups and the project row, retaining the tombstone and audit chain.
Both organization deletion paths enqueue the same jobs before removing the parent.
An upload rechecks access after writing and removes its object if deletion/archive
raced the upload. Auth precedes edge-cache reads, so cached data cannot bypass a
tombstone. Legacy shared-token requests retain their isolated single-level team
namespace and cannot address a project prefix.

## Retention

Every two minutes, maintenance sweeps one bounded page from the least recently
scanned project. Cursors persist in D1 and rotate fairly across projects. It uses
the current effective retention, preserving newer artifacts and other prefixes.
The bucket-wide deployment lifecycle remains a maximum-age backstop.

Native prefix rules are optional because the R2 Worker binding cannot configure
bucket lifecycle. To enable them, set root `R2_LIFECYCLE_API_TOKEN` (account-scoped
Workers R2 Storage Write), `R2_LIFECYCLE_ACCOUNT_ID`, and the physical Artifacts
bucket name in `R2_LIFECYCLE_BUCKET` for the next explicitly requested deployment.
The secret stays in Secrets Store. Create/save immediately reconciles the prefix
rule; cron repairs drift after deployment and policy changes. Existing unrelated
rules are preserved. At 1000 total rules, or without control-plane access, the
sweeper enforces retention. API errors are logged and the sweeper continues.

Cloudflare's [lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)
replaces the complete rule set; avoid concurrent manual lifecycle changes while
reconciliation is active. Retention deletion is asynchronous, as with native R2
lifecycle, and full scan latency grows with the number of prefixes/pages.

Validate with `bun run check` and `bun run test`. Focused suites exercise migrated
SQLite, signed session/JWT HTTP, failed R2 retry, prefix isolation, native rule
capacity and retention cursors. They require no cloud credentials or deployment.

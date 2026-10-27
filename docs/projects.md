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
Query parameters can only confirm the org ID (`teamId`) or the immutable org slug
or ID (`slug`); mismatches return 403. Turbo sends `TURBO_TEAM` through `slug` when
the value does not begin with `team_`, including UUID organization IDs saved by
the CLI. Every supplied value must still match the credential's own tenant.
Identical hashes in separate projects remain
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

## Trust policy administration

Session-authenticated project admins can manage policies through:

| Method | Path                                     | Result                                        |
| ------ | ---------------------------------------- | --------------------------------------------- |
| GET    | `/projects/:id/trust-policies`           | List policies                                 |
| POST   | `/projects/:id/trust-policies`           | Create (201)                                  |
| PUT    | `/projects/:id/trust-policies/:policyId` | Replace body/provider/enabled                 |
| DELETE | `/projects/:id/trust-policies/:policyId` | Delete (204)                                  |
| POST   | `/projects/:id/trust-policies/test`      | Simulate saved policies against sample claims |

Requests use the flattened `TrustPolicyRequest` in `@repo/api-spec`; responses add
`id`, `projectId`, `createdBy`, and `createdAt`. Updates preserve creation metadata.
All routes require a live session and `project:admin` (the same authorization as
managing grants). Mutations also require the canonical Origin and any configured
passkey step-up. Policy IDs are scoped to their project; unknown IDs return 404.
Bodies are capped at 16 KiB. Responses use `Cache-Control: no-store`.

Policy mutations and their audit events commit atomically. Deleting a project or
organization disables its policies in the deletion transaction. The additive
`created_at` column uses epoch zero for policies that predate this version.

Project creation optionally accepts a GitHub source:

```json
{
  "slug": "builds",
  "name": "Build cache",
  "github": {
    "repository": "acme/app",
    "repositoryId": "123456",
    "repositoryOwnerId": "7890",
    "defaultBranch": "main",
    "audience": "https://cache.example.com"
  }
}
```

This creates two policies in the project's creation transaction, with their IDs
included in its audit event: the exact repository and default-branch ref receive
read/write; the exact repository and `repo:acme/app:pull_request` subject receive
read-only. Both use immutable repository and owner IDs, the supplied audience and a 600-second TTL. The write default also requires `event_name=push`. Supply an audience
accepted by the deployment's OIDC verifier. Without source metadata, creation does
not infer a repository, branch, or audience and creates no policies. Additional
repositories can share a project through additional policies, and the same
repository can have policies in multiple projects. Vercel defaults follow in STV-491.

See [trust policy matching](../packages/oidc/README.md#trust-policies) for exact
matching, ref patterns, overlap resolution and exchange integration responsibilities.

### Guardrails and policy tester

Policy saves enforce immutable provider IDs, accepted audiences, the effective
issuer allowlist, TTL ceiling and bound-token requirements. GitHub default source
metadata must include numeric `repositoryId` and `repositoryOwnerId`; names alone
are refused. A default write policy requires `event_name=push` as well as the branch.
Strict instance/org workflow and environment allowlists apply to generated defaults
as well; create manually constrained policies when those defaults cannot satisfy
the strict settings.

List/create/update responses include `errors` and `warnings` with stable codes,
claim names where relevant, and messages. Existing unsafe policies remain visible
with errors so admins can repair or delete them. Warning codes include
`broad_write_refs`, `unrestricted_write_job`, `ttl_near_maximum`, and
`untrusted_writes_enabled`. Enabling `allowUntrustedWrites` is an explicit security
override for broader write events, with a persistent warning and audited flag.

`POST /projects/:id/trust-policies/test` takes `{ "claims": { ... } }` and evaluates
saved project policies. The response includes `simulation: true`, matching IDs,
resulting scope/TTL/binding requirement, and each policy's rule results and
warnings/errors. Invalid policies cannot contribute to the simulated grant.
It requires the same live project-admin session and matching Origin as policy
mutations, shares their 16 KiB limit and no-store response, and never issues a token
or writes policy/audit rows. Sample claims have no authentication authority.

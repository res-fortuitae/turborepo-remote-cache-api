# Authorization

`@repo/authz` is the policy decision point for project, grant, credential and
cache handlers. `decide` is pure: it combines live resource/session facts, current
organization statements, the strongest project grant and the effective instance
policy. `can` returns a decision; `require` returns a typed `AuthzError` on denial.
Fact-read or audit-delivery failures are distinguished by `reason: unavailable`
and must map to 500, not an ordinary 403.

`AuthorizationLive` requires GrantRepo, MembershipRepo and InstanceSettingsRepo.
`AuthorizationDatabaseLive` supplies their production implementations, leaving
Database explicit. The host supplies deployment ceilings and a durable
AuthorizationAudit adapter. Project handlers bridge that port to AuditLog;
denials fail closed if audit is unavailable. The test layer uses fresh migrated
SQLite and an isolated in-memory audit sink.

Session decisions require an active, unbanned, non-impersonated session. Current
organization membership is mandatory for grants, including team grants. Instance
owners/admins gain organization powers only through a live session-bound elevation.
API keys and JWT principals can perform only their cache scopes and must match
both the organization and project IDs. No role or elevation can override a
credential's tenant or scope. Archive blocks cache writes while preserving reads.
Lifetime, signing, bound-token and requested-policy constraints fail closed.

`forRequest` creates a decision snapshot with memoized results. Its lifetime is one
request; a new request builds a new snapshot and observes revoked memberships,
grants, policy and elevation. The ordinary methods always read current facts.

Review rule: new project/cache/trust-policy handlers must use Authorization, not
compare role names or query grant tables themselves. Authentication and native
Better Auth plugin callbacks remain owned by `@repo/auth` and its shared role
definitions. Cross-domain adapters supply authenticated principals; HTTP query
parameters never establish a principal's organization or project.

The permission matrix in `packages/authz/src/permission-matrix.test.ts` covers
122,880 combinations of instance role, elevation, organization role, direct grant,
team grant, team membership, credential kind/scope and action. The same independent
acceptance table drives both pure decisions and fresh SQLite repository facts.
Each credential/action combination also checks a different organization and a
second project in the same organization. New exported actions must be represented
in the acceptance table. Live policy tests verify TTL/signing/binding clamps and
audit failure behavior; signed JWT HTTP tests reject spoofed team selectors and
clean up an upload that races project deletion. `.github/workflows/validate.yml`
runs `bun run check` and `bun run test` on every PR without cloud credentials.

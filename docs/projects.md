# Project management (M2, first slice)

`@repo/projects` owns the `Projects` Effect service. It uses the existing project
table and `ProjectRepo`, the session/org portion of `Authorization`, and `AuditLog`.
The Worker provides policy configuration, upload/retention ceilings and database
bindings. No migration or infrastructure deployment is needed for this slice.

## HTTP API

These routes implement the existing `@repo/api-spec` contracts:

- `POST /orgs/:id/projects`: create, returning 201 and a project.
- `GET /orgs/:id/projects?limit=50&cursor=...`: list by stable project ID. The
  maximum page size is 100. Use `nextCursor` for the next page.
- `GET /projects/:id`: read a project.
- `PATCH /projects/:id`: update name, slug, description, limits or `archived`.
  `archived: true` archives; `archived: false` restores. Description accepts null.

Requests need a live Better Auth session cookie. Mutations also need an `Origin`
header equal to the instance's canonical origin. JSON bodies are limited to 16 KiB.
Responses, including errors, use `Cache-Control: no-store`. The legacy shared
bearer token cannot manage projects.

Owner/admin organization roles receive `project:create`, `project:read` and
`project:update`. Custom roles can delegate these statements individually.
Members and auditors have no default project-management access in this slice.
Grant-based visibility follows in STV-439/440. Instance owner/admin status alone
does not grant organization access: a live, session-bound elevation is required
unless the user already has the necessary organization membership. Banned users,
impersonated sessions, expired sessions and removed members are rejected on the
next request. Archived organizations remain readable but reject project mutations.
When policy requires passkey step-up, mutations require recent session-bound proof.

Slugs use lowercase letters/digits separated by single hyphens, at most 64
characters; they are unique within each organization. Name is nonblank and at
most 100 characters; description is at most 2000 characters. Renames preserve the
project ID and organization ID. Create, update, archive and restore commit the
project change and its chained audit event in the same D1 batch. Authorization
denials are recorded durably.

Project retention is clamped to the bucket's deployment retention and the current
instance/organization retention policy. Maximum artifact size is clamped to the
serving upload capability and the current policy's quota. Omitted limits use the
host defaults, subject to those ceilings. Reads calculate effective limits again,
so tightening policy also affects existing project responses.

## Remaining STV-438 work

This is the management foundation, not the completed ticket or milestone:

- Cache routing still uses the legacy shared-token/team namespace. M3's credential
  resolver must bind every credential to one org/project and use
  `{orgId}/{projectId}/{hash}`. Until then, project settings/archive state do not
  control legacy cache traffic. Archived-project writes must be denied when
  project-aware cache routing is installed.
- Per-project retention is stored/clamped but does not yet install R2 lifecycle
  rules or a sweeper. The existing bucket-wide deployment retention still applies.
- `DELETE /projects/:id` returns 503 after authentication/access checks and leaves
  the project intact. Confirmation, durable batched R2 cleanup, credential
  revocation, trust-policy shutdown, outstanding JWT revocation and organization
  deletion integration must ship together before deletion can be enabled.
- Project grants, the complete principal/action decision service and the full
  permission matrix follow in STV-439, STV-440 and STV-441 respectively.

Validate with `bun run check` and `bun run test`. The focused tests cover real
migrated SQLite services and signed-session HTTP requests, without cloud credentials
or deployments.

# Instance identity

Better Auth serves the instance API under `/api/auth`. Instance roles (`owner`,
`admin`, `auditor`, `member`) are independent of organization membership.
The first newly registered user claims ownership with an atomic D1 update.
An upgrade with existing users assigns ownership on the next new registration;
operators should control initial access before enabling public sign-in.

Owners/admins use `GET/POST /api/auth/instance/settings` (`{ policy }` on POST).
`deploy.config.ts.identityCeilings` limits token TTL, API-key lifetime, retention,
quota and OIDC issuers. Runtime changes cannot exceed those limits. API keys
are `warn` by default, lifetime 30 days, hard maximum 90. Credential issuance
and project authorization consume this policy in their own milestones.

`POST /instance/set-role` takes `{ userId, role }` (all paths here are relative
to `/api/auth`). Native `/admin/set-role` and arbitrary user edits are disabled.
Changing roles revokes sessions. A single SQL condition preserves the last active
owner under concurrent demotions. Owners must be demoted before banning them.
Native Better Auth list/get/ban/unban/revoke endpoints remain available; their
mutations require a live, non-impersonated D1 session and durable audit intent.
Only owners can impersonate; `/admin/impersonate-user` also requires `reason`,
and sessions last at most five minutes. End with `/admin/stop-impersonating`.
No developer tokens or device sessions are issued yet; those later services must
honor user bans and revocation before issuing or accepting credentials.

`GET /instance/orgs` lists at most 100 organizations. `POST /instance/orgs/create`
takes `{ name, slug, ownerId }` and assigns an active lead as owner. It does not
make the instance admin an org member. `POST /instance/orgs/elevate` takes
`{ orgId, reason, ttlSeconds? }` (default five minutes, maximum fifteen).
The grant is bound to the live session, and its audit event belongs to the org.
`POST /instance/orgs/manage` takes `{ orgId, action, reason, ownerId? }`;
`action` is archive, restore, transfer or delete, and requires elevation.
Deletion refuses orgs with projects. Archived org access is denied by org auth.

Signup email domain restrictions require a verified provider email. Allowed
GitHub organizations use GitHub's public membership check and fail closed on
private/unavailable memberships. An allowlisted organization must expose the
user's membership publicly. When both restrictions are configured, both apply.
Policies apply to returning OAuth sign-ins and account linking too.

## Organizations and invitations

The organization plugin is enabled. An org is a Turbo team, and its immutable,
lowercase slug is `TURBO_TEAM`. `/organization/create` gives the creator the
org owner role, subject to the instance org-creation policy. Instance admins
use `/instance/orgs/create` to assign a lead without becoming org members.
Native member list/update/remove APIs remain available; owner removal and
ownership changes use the explicit transfer operation. Archived orgs deny access.

Use `POST /organization/invite` with `{ organizationId, email?, githubUsername?,
role? }`. Roles are admin or member (default). Username invitations resolve an
existing GitHub-linked user's private account email, so that user must sign in
once first. GitHub-restricted instances require recipients to have signed in;
acceptance rechecks membership. Invites expire after 48 hours. D1 enforces ten
invitations per inviter/org/hour, including failed delivery attempts.

The response contains `{ invitation, url, delivered }`. A disabled/failed mailer
returns `delivered: false` with a usable signed link. Authorized org admins can
retrieve it again via `POST /organization/invitation-link` with `{ invitationId }`.
The fragment contains `id`, `expires`, and `signature`; submit ID and signature
to `/organization/accept-signed-invitation`. The recipient must have a verified,
matching email and a live session, and still satisfy instance signup rules.
Acceptance and a unique consume record commit together in a D1 batch. Native
unsigned acceptance and direct member addition are disabled.

## Groups

Better Auth teams are called **groups** in the product; they are optional sets
of organization members and have no independent role. No default group is
created, and the last group can be removed. `deploy.config.ts.groups` configures
`maxGroups` (default 50) and `maxMembersPerGroup` (default 1,000).
Native `/organization/create-team`, `update-team`, `remove-team`,
`add-team-member`, `remove-team-member`, and list endpoints back the group UI.
Group membership is constrained to organization membership. Native `list-team-members` only answers members of that
group, so `GET /organization/group-members?organizationId=&teamId=` lets any org
member read the composition of any group in their org (the dashboard and access
explanations use it). A group's ID is the
`team` grant principal for M2 project RBAC, never another Turbo team slug.

## Organization administration roles

`organizationAccess` extends Better Auth defaults with project CRUD/grants,
trust-policy CRUD, API-key create/revoke, audit read/export, analytics read,
and billing/settings update. Owners have every statement; admins have every
statement except organization delete/ownership transfer. Members have no org
administration statements; their project reads require M2 grants. Auditors can
read audit and analytics, without export or mutations.

Dynamic roles are enabled (maximum 50/org). Use Better Auth create/update/delete
role APIs. Native role administration and invitation delegation cannot grant
permissions the caller lacks. Invitations accept a built-in or custom role,
except owner; `POST /organization/transfer-ownership` requires the owner role
and an active org member as `newOwnerId`. Instance admins have their separate,
audited elevation path. Org owners can delete an org only after its projects
are removed.

`POST /organization/policy` takes `{ organizationId, policy? }`: omit `policy` to
read effective policy, include it to update. It requires settings:update. Values
are clamped to the instance policy, API-key restrictions and security requirements
can only tighten, and signup allowlists cannot broaden. Disjoint signup lists
are rejected rather than interpreted as unrestricted. Cache access is never
conferred by these role statements; that is the M2 authorization service's job.

## Administrator passkey step-up

Passkeys are a second factor for instance owners/admins. Sign in with GitHub
first, then use `passkeyClient()` from `@better-auth/passkey/client`. Enroll with
`authClient.passkey.addPasskey()` and check the factor with
`authClient.signIn.passkey()`. The server requires user verification, pins the RP
ID/origin to the canonical host, rejects first-factor passkey login, and checks
that the assertion credential belongs to the signed-in administrator.

First enrollment requires a session created within ten minutes. Further
registration/management requires fresh proof. Enroll administrators before
turning `requirePasskeyForAdmins` on in instance policy; enabling it requires
fresh proof from the operator. With the policy on, instance mutation and
elevation endpoints (including native admin mutations) require a D1 proof no
older than five minutes. Read-only views remain available without step-up.
Verification rotates the session and revokes the prior D1 session; proof never
comes from KV, a body parameter, or cookie claims. Changing domains changes the
RP ID, so enroll replacement credentials before such a migration.

GitHub 2FA inspection is not enabled; passkey user verification supplies the
second factor. STV-503's recovery CLI was canceled. If all administrators lose
their factors, an operator with the deployment's Cloudflare credentials must
set `requirePasskeyForAdmins` to false in the singleton D1 instance policy row,
retaining its other settings, re-enroll keys after a new GitHub sign-in, and
re-enable the requirement. Preserve the audit history and record the recovery
reason. There is no unauthenticated recovery endpoint.

## Instance console

The dashboard's Administration page exposes organization health and storage,
user deactivation/ban/session controls, policy editing and passkey step-up.
Auditors can inspect the organization directory and global audit/analytics;
owner/admin roles manage settings and users. `/device` reviews and approves or
denies CLI authorization codes before the session-gated dashboard.

`GET /api/auth/instance/orgs` returns at most 100 organizations and a `nextCursor`;
pass it as `cursor` to continue. Health fields include archive state, project
count, reconciled storage and last cache activity.
`GET /api/auth/instance/orgs/elevations` lists only the current live session's
unexpired grants. Elevating again replaces that session's previous grant for
the organization. `POST /api/auth/instance/orgs/leave` with `{ orgId }` ends those
grants with an audit event; relinquishing access does not require new step-up.
Elevation does not create membership, and native Better Auth organization
administration APIs still require their documented membership permissions.

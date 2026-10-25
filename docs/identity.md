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

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

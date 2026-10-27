# Diagnostics and runner hardening

`tcache doctor --json` reports resolved API/team/project, value sources, detected
CI provider, available selected **unverified** assertion claims, GitHub OIDC
permission hints, PR/`pull_request_target` warnings, runner-persistence heuristics,
health connectivity and server clock skew. It never prints raw assertions,
signatures, session tokens or API keys. It does not acquire a fresh CI assertion
just to display claims; providers that expose no local assertion are reported
without claim details. Detection cannot prove a runner is ephemeral.

When local claims and a project are available, doctor attempts the existing
session-authorized policy tester. `--policy` explicitly requests it in server
mode. This is a simulation, not proof of authentication or authorization. Only
project admins can inspect policy match details. Anonymous and ordinary CI failures
remain generic. Follow the audit-log link or ask a project admin to test stable
repository/issuer claims; never loosen a policy based solely on decoded claims.

`GET /healthz` is public and returns version, schema version, fixed D1/R2/KV/DO
statuses and feature booleans, with 200 or 503 and `Cache-Control: no-store`.
Read-only binding probes run concurrently with a three-second timeout. Use a
sensible monitoring interval; each poll still consumes binding operations. KV is
probed only for availability, not used as an authorization authority. The reported
schema version identifies this API's policy schema, not a migration ledger hash.

`tcache doctor --server https://cache.example.com` additionally invokes an audited
instance-admin self-test after `tcache login`. It requires a live non-impersonated
owner/admin session and fresh passkey proof when instance policy mandates step-up.
It reports GitHub sign-in enablement and org-creation policy only to that admin.
The test creates a random 60-second in-process credential and an isolated
`__selftest/<request-id>` namespace; it exercises PUT, HEAD, GET, metadata query and
events through the same artifact handler, then deletes the object in a finalizer.
No analytics emitter, project row or quota hooks are attached. The credential
never leaves the Worker and cannot authorize a later external request. This
checks the real storage/handler path through one authenticated network request;
it does not validate a public cache credential or the external upload body limit.
Failures retain generic error text. Cleanup failure is reported, and the bucket's
normal retention remains a final fallback.

Use ephemeral self-hosted runners (for example Actions Runner Controller with
one-job runners or an autoscaling VM/container fleet). Destroy the job workspace,
container, home and credential store after each job. Do not share a runner pool
between fork/untrusted PRs and protected workflows. Keep cache-write trust policies
on exact protected branches and workflow identities; use read-only access for PRs.
Never execute untrusted checkout in `pull_request_target` with privileged identity.
Do not persist `.env` exports, proxy state, device sessions, or shell history in
runner images or shared caches. Rotate any scoped API key exposed to a persistent
runner. See [CI authentication](ci-auth.md).

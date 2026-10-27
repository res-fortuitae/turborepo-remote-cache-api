# Developer cache tokens

After `tcache login --api https://cache.example.com` and linking a project, run
`tcache exec -- turbo run build`. The CLI exchanges its private session at
`POST /tokens/dev`, then refreshes the short-lived cache JWT through client-core.
The proxy injects upstream credentials; the wrapped command receives only the
loopback proxy credential. The CLI never puts a JWT in a project config file.

The request is `{ "team": "organization-id", "project": "project-id" }`.
It requires a live user session (cookie or Bearer), a matching `Origin`, current
project read access, and an active user. Impersonation is rejected. The default
scope is `read`, including for project writers and admins. To request writes,
pass `write: true`; both the effective `developerCacheWrites` policy and current
project write permission must allow it. Instance admins can enable that policy;
organization policy can only tighten its parent. Existing policies default to
read-only. Every successful issuance is audited without the token.

`ttlSeconds` is optional and bounded by 43,200 seconds (12 hours). The signer,
instance and effective organization policy, and remaining session lifetime may
all shorten it. The normal instance ceiling remains 900 seconds. Tokens carry
current org/project revocation epochs. Removing a grant blocks future issuance;
use the existing epoch revocation path to invalidate already issued tokens.
Policies requiring artifact signing or sender binding fail closed until the
corresponding developer credential capability is available.

`tcache token --refresh` always obtains a fresh token using a new CLI runtime.
It prints a secret for script compatibility; prefer `exec`. `env` is also an
explicit secret-export mode. Do not send either command's output to CI logs.

Turbo uses `TURBO_API`, `TURBO_TEAM`, and `TURBO_TOKEN` from the command environment.
The CLI does not update `~/.turbo/config.json` or run `turbo login`/`turbo link`;
those target Vercel. Keep any legacy Turbo config out of credential management.

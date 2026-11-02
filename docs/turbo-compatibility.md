# Turbo client compatibility

## What replaces `turbo login` and `turbo link`

This instance implements the Remote Cache API. Vercel account login, team
discovery and Vercel token management use different APIs. Do not run
`turbo login --api <this-instance>` or `turbo link --api <this-instance>`.

The platform's commands are `tcache login` and `tcache link`; device login and
interactive linking are still pending M5 (STV-454/455). Until they ship, sign in
to the instance, create an organization/project and request a scoped cache
credential. Use a short-lived CI cache JWT or an organization-owned API key,
subject to instance policy. See [credentials](cache-credentials.md) and
[API keys](api-keys.md). Do not put a credential in source control.

For direct mode, set `TURBO_API` to the origin, `TURBO_TOKEN` to the credential
and `TURBO_TEAM` to its organization slug. This replaces the Vercel login/link
state. Run `turbo run build --cache=remote:rw` (v2) or
`turbo run build --remote-only` (v1).

The `tcache exec --strict -- turbo run build` command is implemented in the
parallel STV-485 / [PR #43](https://github.com/res-fortuitae/turborepo-remote-cache-api/pull/43)
stack. It uses `TCACHE_API`, `TCACHE_TEAM`, `TCACHE_PROJECT` and, for the API-key
fallback, `TCACHE_API_KEY`. The compatibility workflow pins that implementation
until both stacks merge. This M3 branch does not copy its auth/proxy sources.

### Unsupported identity endpoints

These paths return JSON **404**, code `unsupported_turbo_identity`, with the
message “This cache uses tcache login / tcache link” and a link to this guide.
They bypass dashboard asset handling and require no token. No query parameter,
token or user information is reflected in the response.

| Paths                                                                                                       | Purpose in Turbo                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `/v2/user`, `/v2/teams`, `/v2/teams/:id`                                                                    | Vercel account/team discovery        |
| `/v0/spaces`                                                                                                | Turbo v1 space discovery             |
| `/registration/verify`                                                                                      | Legacy SSO registration verification |
| `/v5/user/tokens/current`, `/v3/user/tokens/current`                                                        | Legacy token metadata/revocation     |
| `/login/oauth/userinfo`, `/login/oauth/token`, `/login/oauth/token/introspect`, `/login/oauth/token/revoke` | Vercel OAuth user/token APIs         |

Paths were checked against the official client sources for
[1.13.4](https://github.com/vercel/turborepo/blob/v1.13.4/crates/turborepo-api-client/src/lib.rs)
and [2.11.10](https://github.com/vercel/turborepo/blob/v2.11.10/crates/turborepo-api-client/src/lib.rs).
The [v2 device login flow](https://github.com/vercel/turborepo/blob/v2.11.10/crates/turborepo-auth/src/device_flow.rs)
also uses `/.well-known/openid-configuration` and `/login/oauth/device-authorization`;
these return the same guidance when pointed at this instance.
The instance's `/api/auth/*` endpoints retain their existing behavior.

## Supported versions

Selection checked against npm on 2026-10-25. The suite verifies an actual upload,
deletes all outputs and local cache, then requires a remote hit that restores the
original bytes. A successful build alone does not establish cache compatibility.

| Turbo   | Selection                         | Upload flag         | Restore flag                             | Local macOS, direct + exec |
| ------- | --------------------------------- | ------------------- | ---------------------------------------- | -------------------------- |
| 2.11.10 | Latest stable v2                  | `--cache=remote:rw` | `--cache=remote:r`                       | Pass                       |
| 2.10.13 | Latest patch of previous v2 minor | `--cache=remote:rw` | `--cache=remote:r`                       | Pass                       |
| 1.13.4  | Last stable v1                    | `--remote-only`     | `--remote-only --remote-cache-read-only` | Pass                       |

Each version runs through both transports with `slug` and `teamId`, signatures
on/off, preflight on/off, and `TURBO_REMOTE_CACHE_TIMEOUT=15`. Signed cases use
`remoteCache.signature: true`, `TURBO_REMOTE_CACHE_SIGNATURE_KEY` and
`--preflight`; changing the signature key must produce a miss. The server
preserves `x-artifact-tag`; Turbo performs signature verification. See Turbo's
[configuration reference](https://turborepo.dev/docs/reference/configuration#remote-cache)
and [preflight flag](https://turborepo.dev/docs/reference/run#--preflight).

Turbo sends a `teamId` selector only when its configured ID starts with `team_`.
Use the organization slug for normal installations whose IDs have another
format. Selectors only confirm the organization in scoped credentials; they
cannot select another tenant or project.

`OPTIONS /v8/*` returns 204, an explicit authorization allowance and no redirect.
Subsequent reads/writes still require authorization. The exec proxy also
requires its local session secret before returning preflight headers.

Turbo v1 sends unknown-length chunked uploads. The Worker streams those to R2
in sequential 5 MiB parts, enforcing the effective direct-upload limit while
reading. Over-limit or failed bodies abort the multipart upload; no completed
artifact is published. Empty uploads remain valid. Whole artifacts are never
buffered. Known-length uploads retain their early length guard. Zone limits
still apply before Worker execution; use the multipart transport for large
artifacts, as described in [multipart uploads](multipart-uploads.md).

## Running the matrix

`.github/workflows/turbo-compatibility.yml` runs **18 jobs**: three versions ×
Linux/macOS/Windows × direct/exec. Every job publishes a behavior table in its
GitHub Actions summary, including failed/incomplete cases. Hosted runner results
are established by those jobs; the local table above does not certify them.

PR/push/release runs use a disposable local **workerd + R2 contract preview**:
the production cache handler with an ephemeral test token and test storage
adapter. This checks the runtime and HTTP contract; it does not exercise the
full deployed identity/D1/Coordinator composition. Existing credential and
project authorization suites cover those layers separately. PR jobs receive
no deployed preview credentials and create no cloud resources.

For full deployed preview coverage, manually run **Turbo compatibility** with
the existing preview's HTTPS origin in the `api` input. Configure a dedicated
write-enabled test credential in the repository secret `TURBO_COMPAT_TOKEN`,
plus repository variables `TURBO_COMPAT_TEAM_ID`, `TURBO_COMPAT_TEAM_SLUG` and
`TURBO_COMPAT_PROJECT`. The test organization must have a `team_`-prefixed ID
to exercise Turbo's ID selector. Both selectors must identify the credential's
organization. The suite fails configuration rather than silently substituting
random tenants. Allow at least 600 requests/minute for concurrent jobs and let
test artifacts expire under normal retention. The workflow never deploys or
destroys infrastructure. Deployments remain an explicit operator action.

Run a local row using Bun:

```sh
TURBO_COMPAT_VERSION=2.11.10 bun test apps/server/tests/compatibility-matrix.test.ts
TURBO_COMPAT_VERSION=1.13.4 TURBO_COMPAT_MODE=proxy \
  TCACHE_COMPAT_BIN=/absolute/path/to/exec-checkout/packages/cli/src/bin.ts \
  bun test apps/server/tests/compatibility-matrix.test.ts
```

The proxy revision is pinned to `61ddd7e4ef4ef9c95479dc4a71fe0ce8e51451e5`
in the workflow, including the authenticated preflight fix. After PR #43 and
this stack merge, remove the secondary checkout/install and point
`TCACHE_COMPAT_BIN` at the current checkout. Re-run all transports before doing so.

## Release maintenance

Before each release, run `bun scripts/turbo-compatibility-versions.ts --check-latest`.
It checks the official npm registry and requires both the workflow and this
table to include the latest v2, previous minor's latest patch, and final v1.
Update the pins/table, run all 18 jobs against the release candidate preview,
and retain the Actions summary as the release's compatibility evidence. The
release-triggered workflow repeats this version guard and matrix; it does not
silently change supported versions or edit the repository.

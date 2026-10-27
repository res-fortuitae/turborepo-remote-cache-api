# turborepo-remote-cache-api

A self-hosted [Turborepo Remote Cache](https://turborepo.dev/docs/openapi) running on Cloudflare Workers + R2, provisioned with [Alchemy](https://alchemy.run) and written with [Effect](https://effect.website).

## Workspace

This Bun + Turborepo monorepo contains:

- `apps/server`: existing Cloudflare Worker and R2 resource declarations.
- `apps/dashboard`: React dashboard built with Bun HTML imports, served on the API origin ([guide](apps/dashboard/README.md)).
- `packages/ui`: shared shadcn Mira components, theme tokens, and utilities ([guide](packages/ui/README.md)).
- `packages/db`: Drizzle schemas, migrations, and composable database/repository layers ([guide](packages/db/README.md)).
- `packages/projects`: authorized project management and transactional audit ([guide](docs/projects.md)).
- `packages/api-spec`: shared Effect HttpApi groups, transport schemas and tagged API errors
  ([contract and consumption guide](packages/api-spec/README.md)).
- `packages/shared`: compatibility schema exports and redacted bearer token types.
- `packages/client-core`: shared CI authentication, exchange, DPoP signing and in-memory refresh
  ([composition guide](packages/client-core/README.md)).
- `packages/action`: bundled Node 24 OIDC GitHub Action with proxy/env modes ([guide](packages/action/README.md)).
- `packages/cli`: local authentication proxy, exec/env modes and server doctor ([guide](packages/cli/README.md)).
- `packages/config`: shared TypeScript, Oxlint, and Oxfmt configuration, including vendored rules from `listener`.

Domain package skeletons and the allowed dependency graph are documented in
[ADR-0001: package boundaries and Effect layers](docs/adr/0001-package-boundaries-and-effect-layers.md).
Run `bun run check:boundaries` to validate workspace dependencies and imports.

The single root `alchemy.run.ts` composes infrastructure. Run `dev`, `deploy`, and
`destroy` from the repository root. Environment files and local `.alchemy` state
also live at the root. When upgrading from the previous layout, move ignored
`apps/api/.env*` files and `apps/api/.alchemy` here before running Alchemy. Do not
replace existing root files or state; reconcile them first. Stack and resource
names are unchanged.

All packages extend `packages/config/tsconfig.base.json`. `bun check` checks the
root composition and application/library sources; `bun run check` additionally
checks every package and runs lint and formatting checks.

```sh
bun run lint          # all workspace JavaScript/TypeScript
bun run lint:fix      # safe lint fixes
bun run format        # format supported files
bun run format:check
bun run typecheck     # cached workspace type checks
bun run test          # copied rule suites and config integration checks
bun run check         # lint, type checks, and formatting
bun run dashboard:dev   # dashboard UI preview with hot reload
bun run dashboard:build # production dashboard assets
bun run setup         # create organization config; bootstrap handoff when available
bun run plan          # Alchemy plan for the configured staging stage
```

Lint severities and formatting options match `listener`; existing lint warnings
remain warnings. Use `bun run lint --deny-warnings` for strict enforcement.
See [shared configuration](packages/config/README.md) for details.

## Setup

Fork this repository into your organization's GitHub account. Deploy the fork
into your own Cloudflare account. Upstream owns `apps/`, `packages/`, the Alchemy
entry point, and tooling: **don't edit; use config**. Put all
organization settings in the root `deploy.config.ts`, and optional templates,
branding, or additional policies in `custom/`. Upstream never commits either
path, so release merges preserve them. `custom/` is an extension storage location;
files there are not automatically loaded or executed by the current API.

```sh
bun install
bun run setup          # asks for domain, jurisdiction, edge cache, and stage names
cp .env.example .env   # set TURBO_TOKEN and BETTER_AUTH_SECRET to long random strings
bun run keygen --out /private/path/signing-key.json
# Store that file's single-line JSON as CACHE_TOKEN_SIGNING_KEY in the root .env.
# Keep the private key outside the repository; never commit it.
bun run deploy         # first run prompts for Cloudflare login and bootstraps the state store
```

The root dev, plan and deploy scripts validate the signing key before starting
Alchemy. A random string is not a JWT signing key: it must be a private Ed25519
SigningKeySet JSON. Existing malformed secrets must be replaced before running
those scripts; no secret is silently regenerated or overwritten.

Setup validates and creates config without overwriting it, then runs the API's
`bootstrap` script when available. Secrets remain in the root `.env`; setup does
not generate them or deploy infrastructure. The first newly registered user
claims instance ownership, so control initial OAuth access before publishing
the instance. See [identity, organizations and passkeys](docs/identity.md).
The setup script's optional bootstrap handoff remains unavailable; use the
scoped API-key management API after signing in. Shared-token cache access
requires `features.legacyToken: true`; see [cache credentials](docs/cache-credentials.md).

See `deploy.config.example.ts` for the typed settings: production and staging
domains, R2 jurisdiction, public GitHub App identifiers, retention and Worker CPU
limits, edge cache, and stage names. Set `githubApp` and the root
`GITHUB_OAUTH_CLIENT_SECRET` together to enable GitHub sign-in through Better Auth.
See [GitHub sign-in and local OAuth checks](docs/github-sign-in.md) and
[CLI device login](docs/device-login.md).
Credentials belong in the root `.env` or a secret store, never in config.

Both organization paths are ignored in a fresh upstream checkout. In your fork,
commit non-secret config with `git add -f deploy.config.ts`; use `git add -f custom/`
for versioned org assets. Future edits to those tracked files work normally.
Do not commit secrets.

The deploy prints the Worker `url`. `bun run dev` runs it locally with hot reload.
Development uses Alchemy's local providers and on-disk state in the root
`.alchemy/` directory. It needs `deploy.config.ts` and the required root `.env`
secrets, but no Cloudflare account or state-store bootstrap. Worker, R2 (including
audit checkpoints), D1 with migrations, KV, Durable Objects, Secrets Store, rate
limits, cron triggers, and dashboard assets run in Alchemy's local workerd runtime.

Basin Streams, Pipelines, and Catalog have no local resource providers in the
pinned Alchemy version. Development never provisions them, even when
`BASIN_CATALOG_TOKEN` is set: audit events remain in local D1 and export is disabled.
Development also ignores custom domains, including when an explicit stage matches
a configured production or staging name. Deployments continue to use Cloudflare
state and the configured domains and Basin export.

Deploy/destroy default to `stages.production`; plan defaults to `stages.staging`.
An explicit `--stage` or `ALCHEMY_STAGE` takes precedence. Development keeps
Alchemy's local stage default. Production domains only attach to the production
stage; use `stagingDomain` for staging. Existing installations must preserve their
current stage name; see [UPGRADING.md](UPGRADING.md).

API, dashboard and auth share that origin. Optional `oidcAudiences` pins accepted
CI audience identifiers across domain changes; it defaults to each stage's origin.
See [origin, audiences and upload limits](docs/origin-and-audiences.md) for migration
steps, security headers and Cloudflare plan limits.

Organization-owned API keys and their management API are documented in
[API-key fallback](docs/api-keys.md). See [cache credentials](docs/cache-credentials.md)
for JWT/API-key routing, project isolation, and the opt-in legacy migration flag.
[Request guards](docs/request-guards.md) documents credential/IP rate limits,
organization policy ceilings, and batch/upload bounds.
[Anomaly detection](docs/anomaly-detection.md) covers verified identity baselines,
write/exchange signals, administrator alerts and optional read-only/revocation containment.
[Upload provenance and incident response](docs/artifact-purge.md) covers dry-run
filters, audited background purge jobs, the dashboard, and `tcache admin purge`.

The CI ID-token verifier and its replay/cache guarantees are documented in
[`@repo/oidc`](packages/oidc/README.md). `POST /oidc/exchange` issues project-scoped cache JWTs; see that guide for
policy, audit, rate-limit, supported CI issuers and pinned custom issuer configuration,
DPoP binding, and pending artifact signature delivery.

M2 project management supports CRUD, direct/team grants, live authorization,
archive and durable deletion. Verified cache JWTs use isolated project prefixes.
See [project management](docs/projects.md) for routes, policy ceilings and retention.

See [OIDC acceptance and runner probes](docs/oidc-e2e.md) for the four-case real
Turbo suite, hosted runner workflow, optional existing-preview tests and CI dogfood
configuration.

Audit coverage and reconciliation are documented in [audit events](docs/audit-events.md).
See [audit query and export](docs/audit-query.md) for scoped history and streaming downloads.

## Upstream releases

Maintainers publish stable semver tags (`vMAJOR.MINOR.PATCH`) with a matching
version section in `UPGRADING.md`. There is no automated release or fork sync;
to upgrade a fork, merge the release tag manually, follow its `UPGRADING.md`
notes, and run `bun run check`, `bun run test`, and `bun run plan` before deploying.

## Use it from Turborepo

See [Turbo compatibility](docs/turbo-compatibility.md) for supported versions,
the CI matrix, preflight/signatures, and what replaces `turbo login` / `turbo link`.

```sh
export TURBO_API=https://<your-worker>.workers.dev
export TURBO_TOKEN=<cache JWT or tcache_ API key>
export TURBO_TEAM=my-org-slug   # must match the credential's organization
turbo run build
```

## Endpoints (all require `Authorization: Bearer $TURBO_TOKEN`)

| Method | Path                   | Description                             |
| ------ | ---------------------- | --------------------------------------- |
| GET    | `/v8/artifacts/status` | Caching status (`enabled`)              |
| HEAD   | `/v8/artifacts/:hash`  | Check whether an artifact exists        |
| GET    | `/v8/artifacts/:hash`  | Download an artifact                    |
| PUT    | `/v8/artifacts/:hash`  | Upload an artifact (202)                |
| POST   | `/v8/artifacts`        | Query metadata for many hashes          |
| POST   | `/v8/artifacts/events` | Record cache events (validated, logged) |

Opt-in legacy shared-token artifacts use `<teamId|slug|default>/<hash>`; verified JWTs and API keys use
`{orgId}/{projectId}/{hash}`. The `x-artifact-*` headers are kept as R2 custom metadata.

## Cloudflare resources

`@repo/infra` declares every resource; the root `alchemy.run.ts` composes them and
the API Worker binds them:

| Resource               | Binding                                                                | Purpose                                                             |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| R2 bucket `Artifacts`  | `Artifacts`                                                            | Cache artifacts, with lifecycle rules                               |
| D1 database `Database` | `Database`                                                             | System of record                                                    |
| KV namespace `Cache`   | `Cache`                                                                | Rebuildable caches only (auth secondary storage, JWKS, drill-downs) |
| Durable Object         | `Coordinator`                                                          | Revocation epochs and other strongly consistent primitives          |
| Secrets Store secrets  | `SigningKey`, `BetterAuthSecret`, `GitHubOAuthSecret`, `BasinSqlToken` | Stored as `<stage>_<ENV_NAME>` in the account store                 |
| Rate Limiting          | `RATE_LIMITER`                                                         | Request ceilings (`@repo/ratelimit`)                                |
| Static assets          | `ASSETS`                                                               | Dashboard build in `apps/dashboard/dist`                            |

The GitHub OAuth and Basin secrets are created only when their variables are set.
Cloudflare allows one Secrets Store per account; Alchemy adopts it and never deletes it.

Persistent resources use Alchemy retention outside explicitly named preview/PR
stages. This includes the API Worker because it owns the Coordinator namespace.
Artifacts and KV remain disposable. The jurisdiction-aware `Backups` bucket is
reserved storage; no backup job is installed. See [deletion protection and
recovery](docs/deletion-protection.md) before destroying or re-adopting a stack.

## Retention

The R2 bucket has lifecycle rules (`packages/infra/src/index.ts`): artifacts are deleted
`limits.artifactRetentionDays` (30 by default) days after upload, and incomplete
multipart uploads are aborted after a day. Cloudflare applies the bucket maximum natively. Project maintenance also runs a
bounded retention sweep, with optional native prefix rules; see [project retention](docs/projects.md#retention). Choose `jurisdiction` before creating the bucket;
changing residency of existing data needs a separate migration.

## Edge caching

Downloads are stored in the datacenter's Workers Cache (`packages/artifacts/src/edge-cache.ts`) for an hour, so repeat downloads skip R2. The cache is looked up _after_ authentication and keyed by the credential’s organization + project + cache generation + hash. Artifacts over 512 MB bypass edge caching. Project purges invalidate copies across locations within five seconds; see [purge semantics](docs/cache-credentials.md#purging-edge-copies). Uploads evict the local copy. Responses carry `x-edge-cache: HIT|MISS`.
Set `features.edgeCache=false` to bypass the cache for downloads and uploads.

When a jurisdiction is set, artifact edge caching is disabled regardless of the
feature flag, and downloads use `Cache-Control: no-store`. See
[data residency](docs/data-residency.md) for guarantees and migration limitations.

## Testing

| Layer          | Command                                                 | Needs                                                        |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Unit           | `bun run test`                                          | nothing: no Wrangler, credentials, or network                |
| Running Worker | `TURBO_API=<url> TURBO_TOKEN=<token> bun run test:live` | `bun run dev` or a deployed URL                              |
| Local stack    | `bun run test:stack`                                    | `deploy.config.ts` and `.env` secrets; runs workerd locally  |
| Deployed stage | `bun run test:deployed`                                 | Cloudflare credentials; deploys, then destroys, a test stage |

Every layer runs the same shared suites from `apps/server/tests/support`:

- **HTTP contract** (`contract.ts`): status, auth, validation, upload/download
  with metadata, team isolation, metadata queries, and events.
- **Permission matrix** (`permission-matrix.ts`): a table of principal ×
  operation → expected status. Later milestones add principals (scoped tokens,
  OIDC identities, roles) and rows here; every layer picks them up.
- **Real turbo** (`turbo.ts`): a temporary workspace builds with
  `--cache=remote:rw` (cache miss, upload), deletes outputs and `.turbo`, then
  requires a `--cache=remote:r` cache hit that restores the output.

Unit tests drive the Worker handler (`apps/server/src/api.ts`) in process with an
in-memory bucket, and serve it on a local port for the turbo round trip. The
stack suites (`tests/stack.test.ts`) deploy the root `alchemy.run.ts` with
Alchemy's `Test` harness: locally by default (workerd with local R2/D1/KV, the
`alchemy dev` topology), or to a real stage with `ALCHEMY_TEST_DEV=0`, named by
`ALCHEMY_TEST_STAGE` (default `test_$USER`). Set `NO_DESTROY=1` to keep it.
Explicit local test runs enable the legacy-token fixture in memory, without
changing the operator config; normal dev and deployed stages keep the configured flag.
Deploy a real stage only when you intend to. All suites use unique team names
and leave artifacts to expire through bucket retention.

[Performance probes and release targets](perf/README.md) cover local JWT/exchange/proxy
measurements, the 200-job k6 fleet workload and staging release gates.

[Threat model and security review](docs/threat-model.md) records the STRIDE controls,
security fixes, residual risks and pre-launch validation gates.
[The M8/M9 validation record](docs/m8-m9-validation.md) lists the stacked PRs,
local checks and outstanding launch validation.
[The STV-508 follow-up](docs/stv-508-validation.md) records real admin, CLI,
cross-device cache, integrity and audit journeys, fixes found, and remaining gates.

## Instance capabilities

Open **Capabilities** in the console (`/#capabilities`), or query
`GET /api/instance/capabilities` with a signed-in session or the instance's bearer
token. Responses use `Cache-Control: no-store` and a versioned shared contract.
The server capability part of doctor is available now:

```sh
TURBO_API=https://cache.example.com TURBO_TOKEN='<token>' bun packages/cli/src/bin.ts doctor --server
# Add --json for the same report used by the console.
```

Deployment detects Workers billing and the serving custom domain's zone plan
separately, using Alchemy's selected account and credentials. It makes read-only
account subscriptions and zone-list API calls, including pagination. Billing or
Zone Read permissions may be missing from scoped tokens: detection then reports
`unknown`, explains the problem, and disables features requiring that entitlement.
An account with no recognized Workers subscription is also `unknown`, never
assumed paid. If billing cannot be read, an operator can explicitly assert
`workersPlan: "free" | "paid"` in `deploy.config.ts`. That assertion must match
the actual account; it does not upgrade the subscription. A zone's Business plan
never establishes Workers Paid. Re-run deployment after changing plans or flags.
Local development skips all probes and uses the fallback layers.

Optional `features.emailSending`, `features.analytics`, `features.auditHistory`,
and `features.directUploads` flags default to requested. Set a flag to `false`
to select its fallback even when the plan is eligible. Existing config remains
valid. `edgeCache` keeps its existing behavior. Custom Worker CPU limits are
only sent for a detected/asserted Workers Paid account.

- **Analytics:** lite mode batches remote hit/miss/request/time-saved counters in
  D1's existing hourly rollup table. Local hits are excluded. The Turbo API uses the credential’s organization and project; opt-in legacy
  requests use their team namespace for both. Counter writes run under `waitUntil`, and
  failures are logged without failing cache traffic. Counters are at least once;
  retransmitted event batches can count twice. `analytics: false` selects a no-op
  emitter. Workers Paid, the default jurisdiction, `BASIN_CATALOG_TOKEN` and
  `BASIN_SQL_TOKEN` enable Basin telemetry and hourly/daily D1 rollups. Sampling,
  freshness, inventory reconciliation and limits are documented in
  [analytics](packages/analytics/README.md).
- **Audit:** Iceberg export requires Workers Paid, the default jurisdiction,
  `BASIN_CATALOG_TOKEN`, and an enabled flag. Otherwise no audit Basin resources
  are provisioned. The configured hot window grows from 90 to 365 days;
  unexported rows are never pruned, so D1-only audit data remains indefinitely.
  Budget D1 storage accordingly. Switching away from Basin retains existing
  stateful resources under the normal deletion-protection policy.
- **Email:** configure `email.from` after onboarding the sender domain to enable Cloudflare
  Email Service on Workers Paid. Without it, use signed invite links and GitHub
  sign-in. See [transactional email](docs/email.md); the dashboard invite screen
  follows in STV-468.
- **Uploads:** Free, Pro, workers.dev, and unknown plans use a conservative
  100,000,000-byte request ceiling. A Business/Enterprise serving zone permits
  up to 200,000,000 bytes in this version; Cloudflare can impose a lower zone
  upload setting before the Worker runs. `directUploads: false` restores the
  conservative ceiling. The [multipart API and shared proxy transport](docs/multipart-uploads.md) support
  larger artifacts; the `tcache exec` command follows in STV-485.

Plan prerequisites follow Cloudflare's [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
and [Workers request limits](https://developers.cloudflare.com/workers/platform/limits/).

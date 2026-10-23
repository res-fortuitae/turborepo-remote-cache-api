# turborepo-remote-cache-api

A self-hosted [Turborepo Remote Cache](https://turborepo.dev/docs/openapi) running on Cloudflare Workers + R2, provisioned with [Alchemy](https://alchemy.run) and written with [Effect](https://effect.website).

## Workspace

This Bun + Turborepo monorepo contains:

- `apps/server`: existing Cloudflare Worker and R2 resource declarations.
- `apps/dashboard`: dashboard scaffold (application shell follows in STV-466).
- `packages/shared`: Effect schemas and redacted bearer token types.
- `packages/action`: GitHub Action scaffold.
- `packages/cli`: CLI scaffold.
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
bun run setup         # create organization config; bootstrap handoff when available
bun run plan          # Alchemy plan for the configured staging stage
```

Lint severities and formatting options match `listener`; existing lint warnings
remain warnings. Use `bun run lint --deny-warnings` for strict enforcement.
See [shared configuration](packages/config/README.md) for details.

## Setup

Fork this repository into your organization's GitHub account. Deploy the fork
into your own Cloudflare account. Upstream owns `apps/`, `packages/`, the Alchemy
entry point, tooling, and workflows: **don't edit; use config**. Put all
organization settings in the root `deploy.config.ts`, and optional templates,
branding, or additional policies in `custom/`. Upstream never commits either
path, so release merges preserve them. `custom/` is an extension storage location;
files there are not automatically loaded or executed by the current API.

```sh
bun install
bun run setup          # asks for domain, jurisdiction, edge cache, and stage names
cp .env.example .env   # set TURBO_TOKEN and each secret to a long random string (e.g. `openssl rand -hex 32`)
bun run deploy         # first run prompts for Cloudflare login and bootstraps the state store
```

Setup validates and creates config without overwriting it, then runs the API's
`bootstrap` script when available. Automatic secrets, owner setup links, and the
GitHub App manifest bootstrap are pending [STV-499](https://linear.app/stvyas-workspace/issue/STV-499).
Until then setup reports that bootstrap is pending; use the existing token-based
setup above. Setup itself does not deploy infrastructure.

See `deploy.config.example.ts` for the typed settings: production and staging
domains, R2 jurisdiction, public GitHub App identifiers, retention and Worker CPU
limits, edge cache, and stage names. GitHub App identifiers are reserved for the
bootstrap/auth integration; they do not enable authentication in the current API.
Credentials belong in the root `.env` or a secret store, never in config.

Both organization paths are ignored in a fresh upstream checkout. In your fork,
commit non-secret config with `git add -f deploy.config.ts`; use `git add -f custom/`
for versioned org assets. Future edits to those tracked files work normally.
Fork CI needs the tracked config for staging plans. Do not commit secrets.

The deploy prints the Worker `url`. `bun run dev` runs it locally with hot reload.
Deploy/destroy default to `stages.production`; plan defaults to `stages.staging`.
An explicit `--stage` or `ALCHEMY_STAGE` takes precedence. Development keeps
Alchemy's local stage default. Production domains only attach to the production
stage; use `stagingDomain` for staging. Existing installations must preserve their
current stage name; see [UPGRADING.md](UPGRADING.md).

## Upstream releases and fork sync

Maintainers publish stable semver tags (`vMAJOR.MINOR.PATCH`) with a matching
version section in `UPGRADING.md`. The release workflow runs checks and tests and
publishes those migration notes as a GitHub release. Release publishing is limited
to the canonical upstream repository. Forks consume releases; they do not publish
upstream releases by pushing tags.

Upstream sync is disabled by default. In your fork:

1. Enable GitHub Actions (GitHub disables scheduled workflows in new forks).
2. Set repository variable `UPSTREAM_SYNC_ENABLED=true`. The workflow discovers
   the upstream from the fork's parent; a copied repository must also set
   `UPSTREAM_REPOSITORY=StvyaSharma/turborepo-remote-cache-api`.
3. Add `UPSTREAM_SYNC_TOKEN`, a fine-grained token with Contents and Pull requests
   write permissions on the fork, and read access to upstream if it is private.
   A dedicated token is necessary because PRs created using `GITHUB_TOKEN` do not
   trigger PR workflows. Enable Actions permission to create pull requests.
4. Commit your non-secret `deploy.config.ts`. Create a protected GitHub environment
   named `staging`, with required reviewers, and configure `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`, `ALCHEMY_PASSWORD` (if required by your state setup), and
   `STAGING_TURBO_TOKEN`, `STAGING_CACHE_TOKEN_SIGNING_KEY`, and
   `STAGING_BETTER_AUTH_SECRET`. Use staging credentials and approve only trusted upstream
   code: Alchemy evaluates repository TypeScript while planning. Provision the
   staging state store once through an explicitly authorized staging deployment;
   a read-only plan cannot bootstrap an absent state store.

The hourly job (also available through **Run workflow**) checks published releases
and opens one PR per unmerged stable release tag, with release and migration
notes. It skips drafts, prereleases, tags already merged, and releases whose sync
PR was closed. A conflicting release opens a PR at the tag with instructions to
resolve conflicts. Each PR runs typecheck, tests, formatting/lint, and an Alchemy
plan against the configured staging stage; no deployment runs. Review the plan
before merging, then deploy explicitly. Missing migration notes fail the sync
rather than silently omitting upgrade instructions.

The Fork ownership workflow warns when the fork diverges from upstream in
upstream-owned paths. This is advisory, so intentional upstream contributions
remain possible. Inspect warnings before accepting an upgrade. Scheduled sync
requires GitHub Actions minutes and token access to both repositories.

## Use it from Turborepo

```sh
export TURBO_API=https://<your-worker>.workers.dev
export TURBO_TOKEN=<same token>
export TURBO_TEAM=my-team   # artifacts are namespaced per team
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

Artifacts are stored in R2 under `<teamId|slug|default>/<hash>`, and the `x-artifact-*` headers are kept as R2 custom metadata.

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
| Static assets          | `ASSETS`                                                               | Dashboard build in `apps/dashboard/public`                          |

The GitHub OAuth and Basin secrets are created only when their variables are set.
Cloudflare allows one Secrets Store per account; Alchemy adopts it and never deletes it.

## Retention

The R2 bucket has lifecycle rules (`packages/infra/src/index.ts`): artifacts are deleted
`limits.artifactRetentionDays` (30 by default) days after upload, and incomplete
multipart uploads are aborted after a day. Cloudflare applies these natively, so
no cron Worker is needed. Choose `jurisdiction` before creating the bucket;
changing residency of existing data needs a separate migration.

## Edge caching

Downloads are stored in the datacenter's Workers Cache (`apps/server/src/edge-cache.ts`) for an hour, so repeat downloads skip R2. The cache is looked up _after_ authentication and keyed by team + hash. Uploads evict the local copy. Responses carry `x-edge-cache: HIT|MISS`.
Set `features.edgeCache=false` to bypass the cache for downloads and uploads.

When a jurisdiction is set, artifact edge caching is disabled regardless of the
feature flag, and downloads use `Cache-Control: no-store`. See
[data residency](docs/data-residency.md) for guarantees and migration limitations.

## Migration verification

Start the local Worker with `bun run dev` and copy its printed URL. In another
terminal, run the HTTP contract suite and a real Turbo upload/download round trip:

```sh
TURBO_API=http://localhost:1337 TURBO_TOKEN=<local-token> bun run test:api
TURBO_API=http://localhost:1337 TURBO_TOKEN=<local-token> bun run test:e2e
```

Use the actual port printed by Alchemy. These checks use isolated team names and
leave test artifacts to expire through bucket retention. The Turbo test creates
a temporary workspace, verifies an upload, deletes local outputs and cache, then
requires a remote cache hit and restored output. Neither check deploys resources.

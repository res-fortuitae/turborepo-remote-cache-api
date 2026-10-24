# turborepo-remote-cache-api

A self-hosted [Turborepo Remote Cache](https://turborepo.dev/docs/openapi) running on Cloudflare Workers + R2, provisioned with [Alchemy](https://alchemy.run) and written with [Effect](https://effect.website).

## Workspace

This Bun + Turborepo monorepo contains:

- `apps/server`: existing Cloudflare Worker and R2 resource declarations.
- `apps/dashboard`: dashboard scaffold (application shell follows in STV-466).
- `packages/db`: Drizzle schemas, migrations, and composable database/repository layers ([guide](packages/db/README.md)).
- `packages/api-spec`: shared Effect HttpApi groups, transport schemas and tagged API errors
  ([contract and consumption guide](packages/api-spec/README.md)).
- `packages/shared`: compatibility schema exports and redacted bearer token types.
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
entry point, and tooling: **don't edit; use config**. Put all
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
Do not commit secrets.

The deploy prints the Worker `url`. `bun run dev` runs it locally with hot reload.
Deploy/destroy default to `stages.production`; plan defaults to `stages.staging`.
An explicit `--stage` or `ALCHEMY_STAGE` takes precedence. Development keeps
Alchemy's local stage default. Production domains only attach to the production
stage; use `stagingDomain` for staging. Existing installations must preserve their
current stage name; see [UPGRADING.md](UPGRADING.md).

## Upstream releases

Maintainers publish stable semver tags (`vMAJOR.MINOR.PATCH`) with a matching
version section in `UPGRADING.md`. There is no automated release or fork sync;
to upgrade a fork, merge the release tag manually, follow its `UPGRADING.md`
notes, and run `bun run check`, `bun run test`, and `bun run plan` before deploying.

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

Persistent resources use Alchemy retention outside explicitly named preview/PR
stages. This includes the API Worker because it owns the Coordinator namespace.
Artifacts and KV remain disposable. The jurisdiction-aware `Backups` bucket is
reserved storage; no backup job is installed. See [deletion protection and
recovery](docs/deletion-protection.md) before destroying or re-adopting a stack.

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
Deploy a real stage only when you intend to. All suites use unique team names
and leave artifacts to expire through bucket retention.

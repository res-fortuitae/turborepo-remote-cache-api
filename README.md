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
```

Lint severities and formatting options match `listener`; existing lint warnings
remain warnings. Use `bun run lint --deny-warnings` for strict enforcement.
See [shared configuration](packages/config/README.md) for details.

## Setup

Before the first production deployment, choose `jurisdiction` (`"eu"`, `"fedramp"`,
or omitted for automatic placement) in `apps/server/deploy.config.ts`.
See [data residency](docs/data-residency.md) for guarantees, migration limitations,
and the integration requirements for planned platform services.

```sh
bun install
cp .env.example .env   # set TURBO_TOKEN to a long random string (e.g. `openssl rand -hex 32`)
bun run deploy         # first run prompts for Cloudflare login and bootstraps the state store
```

The deploy prints the Worker `url`. `bun run dev` runs it locally with hot reload.

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

## Retention

The R2 bucket has lifecycle rules (`apps/server/src/bucket.ts`): artifacts are deleted `ARTIFACT_RETENTION_DAYS` (30) days after upload, and incomplete multipart uploads are aborted after a day. Cloudflare applies these natively, so no cron Worker is needed.

## Edge caching

Downloads are stored in the datacenter's Workers Cache (`apps/server/src/edge-cache.ts`) for an hour, so repeat downloads skip R2. The cache is looked up _after_ authentication and keyed by team + hash. Uploads evict the local copy. Responses carry `x-edge-cache: HIT|MISS`.

When a jurisdiction is set, artifact edge caching is disabled and downloads use
`Cache-Control: no-store`.

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

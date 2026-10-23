# turborepo-remote-cache-api

A self-hosted [Turborepo Remote Cache](https://turborepo.dev/docs/openapi) running on Cloudflare Workers + R2, provisioned with [Alchemy](https://alchemy.run) and written with [Effect](https://effect.website).

## Workspace

This Bun + Turborepo monorepo contains:

- `apps/api`: Cloudflare Worker, R2 resources, and Alchemy entry point.
- `packages/config`: shared Oxlint/Oxfmt presets and all custom rules copied from `listener`.

Keep API environment files and local `.alchemy` state in `apps/api`. When migrating
an existing checkout, move its root `.env*` files (except examples) and `.alchemy`
directory there before running Alchemy. The stack and resource names are unchanged.

Root commands forward `dev`, `deploy`, and `destroy` to the API workspace.

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

```sh
bun install
cp apps/api/.env.example apps/api/.env   # set TURBO_TOKEN to a long random string (e.g. `openssl rand -hex 32`)
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

The R2 bucket has lifecycle rules (`apps/api/src/bucket.ts`): artifacts are deleted `ARTIFACT_RETENTION_DAYS` (30) days after upload, and incomplete multipart uploads are aborted after a day. Cloudflare applies these natively, so no cron Worker is needed.

## Edge caching

Downloads are stored in the datacenter's Workers Cache (`apps/api/src/edge-cache.ts`) for an hour, so repeat downloads skip R2. The cache is looked up _after_ authentication and keyed by team + hash. Uploads evict the local copy. Responses carry `x-edge-cache: HIT|MISS`.

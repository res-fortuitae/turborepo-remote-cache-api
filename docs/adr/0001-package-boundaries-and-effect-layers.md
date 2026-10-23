---
status: accepted
---

# Domain packages and composable Effect layers

Each domain owns a workspace package and exposes services implemented by composable
Effect layers. Applications own routing, transport adaptation, and layer composition.
This keeps domain behavior testable without Cloudflare and lets the Worker, dashboard,
CLI, and Action share contracts without sharing application internals. This decision
implements [STV-512](https://linear.app/stvyas-workspace/issue/STV-512).

## Ownership and public interfaces

The Worker is `apps/server` (called `apps/api` in the roadmap). `apps/dashboard`,
`packages/cli`, and `packages/action` are also application entry points, regardless of
folder name. New business rules belong in domain packages; entry points decode requests,
call services, translate typed failures, and compose layers.

A domain package exports only service tags, named `*Live` and `*Test` layers, Schemas,
Schema-tagged errors, and types through `src/index.ts`. Implementation helpers stay
private. A package may also export a `./testing` entry point for Test layers that
need Bun or Node adapters (`@repo/db/testing`, `@repo/auth/testing`), keeping them out
of Worker bundles. Cloudflare's required Durable Object class export is a platform adapter
exception owned by `@repo/coordinator`. Its client service remains runtime agnostic.
`@repo/infra` is a separate build-time exception: it exports Alchemy resource declarations,
not runtime domain services. `packages/config` remains shared TypeScript/lint/format
tooling, never deployment or domain configuration. Vendored rules remain untouched.

The root `alchemy.run.ts` remains the single infrastructure composition root. Environment
files and Alchemy state remain at the root; dev, deploy, and destroy use root scripts.
Resource declarations live in `@repo/infra` (STV-428) without another stack or moved
state. The root composition provides `InfraConfig` and imports infra. The Worker host
(`apps/server`) is the one app that may import it too: Alchemy resolves a Worker's
runtime bindings from the resource declarations it yields, so the Worker yields them
and wraps the bindings in the consuming packages' tags. Other apps and all domain
packages never import infra.

## Package map and allowed dependencies

The **consumer** is on the left; it may import only the listed **providers** on the
right. These are permission ceilings, not dependencies to preinstall. All runtime
packages may use external libraries explicitly declared in their manifests.
`@repo/config` is allowed as a development dependency for tooling only.

| Consumer                       | Owns / provides                                                                  | Allowed workspace providers                                                 | Follow-up issues                       |
| ------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `@repo/api-spec`               | HttpApi groups, transport Schemas                                                | none                                                                        | STV-427                                |
| `@repo/deploy-config`          | deployment Schema, AuthConfig, InstanceCeilings                                  | none                                                                        | STV-498, STV-494                       |
| `@repo/infra`                  | Alchemy resource declarations                                                    | none                                                                        | STV-428, STV-500, STV-502              |
| `@repo/db`                     | Database, repositories, migrations; D1Client tag                                 | api-spec, deploy-config                                                     | STV-429                                |
| `@repo/mailer`                 | Mailer; Email binding tag                                                        | deploy-config                                                               | STV-495                                |
| `@repo/ratelimit`              | RateLimiter; Rate Limiting binding tag                                           | deploy-config                                                               | STV-446                                |
| `@repo/coordinator`            | Coordinator client, DO class; namespace tag                                      | api-spec, deploy-config                                                     | STV-483, STV-504                       |
| `@repo/audit`                  | AuditLog, outbox, reconciler, hash chain; AuditSink tag                          | api-spec, db                                                                | STV-457–459, STV-482                   |
| `@repo/auth`                   | Auth, identity and role definitions                                              | api-spec, deploy-config, db, mailer, audit                                  | STV-432 and sub-issues                 |
| `@repo/authz`                  | Authorization: single policy decision point                                      | api-spec, db, auth                                                          | STV-439–441                            |
| `@repo/credentials`            | CacheTokenSigner/Verifier, CredentialResolver, DPoP, KeyStore                    | api-spec, deploy-config, db, auth, coordinator                              | STV-442, STV-443, STV-445, STV-486     |
| `@repo/oidc`                   | OidcVerifier, issuer registry, TrustPolicyMatcher, JwksCache                     | api-spec, deploy-config, db                                                 | STV-447–449, STV-451, STV-487, STV-491 |
| `@repo/artifacts`              | ArtifactStore, EdgeCache, quotas, generation; R2Bucket and ExecutionContext tags | api-spec, deploy-config, db, authz, credentials, coordinator                | STV-476, STV-492, STV-504, STV-505     |
| `@repo/analytics`              | AnalyticsEmitter/Query, rollups; stream and BasinSqlClient tags                  | api-spec, db                                                                | STV-462–465                            |
| `@repo/client-core`            | exchange client, DPoP signer; HttpClient requirement                             | api-spec                                                                    | STV-484                                |
| `@repo/shared`                 | artifact Schema compatibility re-exports and TurboToken types                    | api-spec                                                                    | migrate contracts in STV-427           |
| server, dashboard, cli, action | routing, presentation, layer composition                                         | domain packages and legacy shared; never another app; infra only for server | respective application issues          |

This graph refines the ticket's broad foundation → persistence → identity → domains →
apps ordering. In particular **auth depends on audit, audit depends on db, and audit
must never import auth**. Actor information is passed as schema-defined data. This
honors Auth's AuditLog requirement without a cycle. Coordinator and mailer are lower
level capabilities. Audit and analytics don't import the domains that emit their
events; shared event contracts belong in api-spec. OIDC exchange orchestration that
needs credentials is composed at the application boundary. Add a cross-domain
requirement by revising this ADR and the explicit policy together; don't invert an
edge or reach through another package's source.

## Effect service and layer conventions

Follow the services/layers, config, and errors guidance in
[Effect Solutions](https://www.effect.solutions/), with the installed Effect version
as the API authority. This workspace uses Effect 4: use `Context.Service` and
`Schema.TaggedError` as exported by the installed package; older guides using
`Context.Tag` must be adapted rather than copied verbatim.

- Requirements enter through Effect services. No package reads `env`, `process.env`,
  `Bun.env`, global bindings, global fetch/cache clients, or mutable module singletons.
  Pure Schema, tag, and layer declarations are safe at module scope. Mutable clients
  and test stores are acquired inside layers, with scoped cleanup where needed.
- Service methods return Effects with explicit success and expected error types.
  Acquire dependencies during layer construction so ordinary methods need no hidden
  environment. Use `Effect.fn` for named operations and `Effect.gen` for sequencing.
- Export `ServiceLive` for production and `ServiceTest` for deterministic in-memory
  behavior. Test state is fresh per layer build. Do not silently provide Live
  dependencies inside another domain's layer; leave requirements visible for the app.
- Use `Layer.succeed` for supplied immutable configuration/bindings, `Layer.effect`
  for effectful construction, and scoped acquisition/release for managed resources.
  Compose dependencies with `Layer.provide` / `Layer.provideMerge` and combine
  independent services with `Layer.mergeAll`. Run Effects only at entry points or
  test boundaries, never at package import time.
- Decode configuration at the composition boundary. Provide AuthConfig,
  InstanceCeilings, HttpClient, clock/random capabilities, and other requirements as
  services. Keep secrets redacted. Effect Config providers, when needed, are selected
  explicitly by the app, never implicitly read by a domain package.
- Expected domain and adapter failures are `Schema.TaggedError`s in the Effect error
  channel. Wrap SDK promises with `Effect.tryPromise` and translate exceptions to
  tagged failures. Do not throw exceptions across a package boundary. Defects denote
  bugs and are logged/handled at the application runtime boundary.

The package owning an adapter also owns its binding tag: db owns D1Client, artifacts
owns R2Bucket, coordinator owns its DO namespace, mailer owns Email, ratelimit owns
Rate Limiting, and audit/analytics own their sink/stream tags. A future KV adapter owns
KvNamespace where it is first needed. The app wraps Alchemy-provided bindings in these
tags and supplies them to Live layers; domain code never looks bindings up globally.
ExecutionContext is similarly provided as a narrow service for background tasks.

Every implemented domain must run with `bun test` using Test layers alone, without
Wrangler, Cloudflare credentials, a Worker runtime, or network access. SDK adapters
are tested against service fakes. Add success, tagged-failure, and isolation cases as
behavior is implemented. Skeletons deliberately have empty entry points and a test
script that accepts no tests; this is scaffolding, not behavioral coverage.

## Enforcement and migration

`bun run check:boundaries` runs before lint/typecheck/format in `bun run check`.
`scripts/package-boundaries.ts` is the executable allowlist. It checks all dependency
fields, declared source dependencies, static/type imports, re-exports, literal dynamic
imports, require/import-equals, private subpaths, relative escapes, and actual cycles.
The checker uses an aliased TypeScript 6 parser because the TypeScript 7 compiler
does not expose the legacy compiler AST API; workspace type checks remain on TypeScript 7.
Unknown workspaces fail closed. Tests, scripts, and config files are scanned too;
vendored/generated files are excluded. Computed module loads are rejected except in the existing
`apps/server/scripts/config.ts` dynamic deploy-config loader. Existing server tooling may read the two root deploy-config files.
Import aliases require a policy change; don't add tsconfig paths or custom resolution
to bypass public package imports. Root composition/tool scripts are outside the domain
policy and may perform build-time composition. Config's own tests may use its tooling.

Boundary checks enforce imports, not business semantics or all uses of globals.
Review must still enforce public export kinds, service injection, and application
ownership. A manifest cycle fails even if its import is type-only or development-only
(except the shared config tooling edge).

This change adds skeletons and policy rather than migrating current behavior. Existing
Worker business logic in bucket/edge-cache/HTTP handling remains operational until
its owning domain issues extract it. Existing deployment helpers stay in server until
STV-494/STV-498 move their contracts to deploy-config. Shared artifact contracts now
live in api-spec (STV-427); shared retains compatibility re-exports and may depend
only on api-spec. No new domain package may import those app implementations.
Keep runtime behavior and infrastructure identity stable during each extraction.

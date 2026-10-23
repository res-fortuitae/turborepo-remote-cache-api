# @repo/api-spec

The canonical, runtime-independent HTTP contract. Runtime dependencies: `effect`
only (currently Effect 4.0.6). Import through `@repo/api-spec`; implementation
modules, Cloudflare bindings, environment reads, clients and live layers belong
in consumers. Nothing starts at import time.

`Api` composes five independently exported groups:

- `CacheApi` (`cache`): the six existing `/v8/artifacts` routes. Upload and download
  bodies stream bytes; HEAD and event ingestion have empty bodies. Upload returns
  JSON at 202. Metadata query results preserve missing artifacts (`null`) and
  per-hash errors. Cache errors remain `{ code, message }`, without a tagged-error
  field. `teamId` and `slug` remain supported query parameters.
- `OidcApi` (`oidc`): `POST /oidc/exchange`, including optional `DPoP`. Token and
  signature-key schemas decode strings to `Redacted` values and encode strings on
  the wire. `expiresAt` is a UTC ISO timestamp; `scope` is `read` or `read write`.
- `AdminApi` (`admin`): project create/list/get/update/delete, grants and trust
  policies. Archive and unarchive use `updateProject({ archived: true | false })`.
  Project deletion returns an empty 202 for asynchronous cleanup. Trust-policy
  replacement uses PUT. Better Auth owns its own user/org/session/plugin routes;
  this package does not duplicate those contracts.
- `AnalyticsApi` (`analytics`): org, project and instance rollups, plus project
  drill-downs selected by a fixed template enum. Clients never supply SQL.
- `AuditApi` (`audit`): org and instance cursor-paginated reads, plus `.csv` and
  `.jsonl` export routes. CSV is a byte stream; JSONL is a typed NDJSON stream of
  `AuditEvent`. Separate paths give each export one explicit streaming media type.
  Audit events carry `schemaVersion: 1` and ULID event IDs.

All request/response Schemas are public. Use `typeof SomeSchema.Type` for a decoded
value and `typeof SomeSchema.Encoded` for its wire representation. Common types
also have same-name type exports. Pagination accepts 1–100 results; `nextCursor`
is `null` at the end. Times use UTC ISO strings. Storage event records for analytics
are defined in STV-462; `CacheEvent` here is the existing Turbo ingestion payload.

## Clients and handlers

```ts
import { Api } from "@repo/api-spec";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const exchange = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, {
    baseUrl: "https://cache.example.com",
  });
  return yield* client.oidc.exchange({
    payload: { token: Redacted.make("oidc-token"), team: "org-id", project: "project-id" },
    headers: {},
  });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

Server hosts implement groups with `HttpApiBuilder.group(Api, "oidc", handlers =>
handlers.handle("exchange", ...))` and mount with `HttpApiBuilder.layer(Api)`.
Compose the group layers at the application boundary. The contract tests contain
an executable in-memory builder/client example requiring no network or platform.

Admin, analytics and audit endpoints declare `ApiAuthorization`. Hosts must supply
its implementation: authenticate the session/credential, resolve tenant scope,
check the endpoint's permission, then run the wrapped effect. The declaration has
no permissive default. Exchange handlers must verify OIDC and enforce trust
policies; cache hosts must authenticate Bearer tokens. Clients supply credentials
through `transformClient` (or their own transport); this package does not retain
credentials or refresh them.

Schemas validate transport structure. Domain services still enforce authorization,
issuer/claim guardrails, scoped query templates, ordered and capped time ranges,
instance ceilings, secret redaction in audit metadata, and transactional auditing.
Tagged failures (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`,
`RateLimited`, `InternalError`, `ServiceUnavailable`) map to their HTTP statuses on
platform endpoints. OIDC denial messages must stay generic.

## Cache compatibility

The Worker imports canonical payload schemas but retains its raw cache handlers.
Do not replace its streaming, HEAD, authentication or response-header behavior as
part of consuming these declarations. A generated cache client returns downloads
as `{ body: Stream<Uint8Array>, headers }` and HEAD as `{ body: void, headers }`.
HEAD errors have empty bodies too, including a missing artifact 404; errors on
other cache methods use the legacy JSON envelope. Consume streams in the calling Effect scope.

`@repo/shared` re-exports the original three cache schemas for existing consumers;
new code imports them here. Its `TurboToken` compatibility type stays in shared.

Run `bun run --cwd packages/api-spec test`, then root `bun run check` and
`bun run test`. Tests cover schema validation, OpenAPI generation, client streaming
and headers, and builder/client success and tagged failures. Live curl and Turbo
round-trip suites remain available via root scripts against an explicitly started
local Worker; package tests do not deploy resources.

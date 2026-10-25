# @repo/client-core

Shared Effect authentication for the Action, CLI and future local proxy. Runtime
imports are only `effect`, `jose` and `@repo/api-spec`. No Node/Bun APIs, environment
globals, provider SDKs or server packages enter the library. All state belongs to a
layer build; create one build per job/process and share it across callers.

## Composition

`ClientCoreLive` composes `ClientConfigLive`, `CiProviderLive`, `ExchangeClientLive`,
`DpopSignerLive` and `TokenCacheLive`. It deliberately leaves these adapters visible:

| Requirement            | Supplied by the host                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `ClientEnvironment`    | `get(name)` for environment values and optional `header(name)` for the current Vercel request |
| `ClientOptions`        | flags, optional config path, and `apiKeysAllowed` from server policy/capabilities             |
| `FileSystem`           | Effect platform filesystem; only bounded streams and existence checks are used                |
| `HttpClient`           | plain Fetch/Node/Bun client without redirect-following or token logging middleware            |
| `ClientMessages`       | safe warnings and secret masking; the Action uses `@actions/core` here                        |
| `ClientCommand`        | executable + argv adapter, without shell interpolation; or `ClientCommandUnavailable`         |
| `DeveloperCredentials` | device-session → developer-token acquisition; or `DeveloperCredentialsUnavailable`            |

Provide these with `Layer.provide` / `Layer.mergeAll` at the app boundary. The
individual `*Live` layers are also public for separate composition and tests. Use
`ClientOptionsLive` for empty flags; production must supply its own messages and
platform adapters. `ClientMessagesTest` is an explicit no-op test adapter.

`ClientConfigLive` resolves flags > environment (`TCACHE_API`, `TCACHE_TEAM`,
`TCACHE_PROJECT`, optional `TCACHE_AUDIENCE`) > `.turbo-cache.json`. Linked config
accepts `api`, organization ID in `team`, project ID in `project`, and optional
`projectSlug`/`audience`. It contains no credentials. `TCACHE_API_KEY` is read only
from the injected environment and wrapped in `Redacted`. HTTP is allowed only on
loopback; API URLs must be origins without paths, credentials, query or fragments.
`TCACHE_STRICT=true|1` enables strict failure; a flag takes precedence.

## Job authentication and refresh

Call `TokenCache.get` at job setup and from the host's refresh maintenance loop.
Concurrent callers share one exchange. Credentials stay in memory, with refresh
30 seconds before expiry (half-life for shorter tokens). Each refresh rereads the
provider source. Failed refreshes clear credentials and impose a 30-second retry
cooldown so concurrent callers do not storm the exchange. `clear` invalidates the
cache/cooldown. No exchange is retried automatically: CI replay IDs are single-use.

Use `TokenCache.peek` on the cache request path. It checks expiry without network,
provider reads or exchange. The host/proxy owns scheduling and process execution
(STV-485); the library starts no background fibers or subprocesses.

By default, acquisition failures warn once per attempt and return `undefined`, so
the host runs Turbo with remote cache disabled. Strict mode returns `ClientAuthError`
instead. Wrap initial layer construction with `authOrDisabled(task, strict)` too,
so malformed/missing configuration follows the same host-selected policy. The host
must actually disable remote cache when no credential is returned; process/Turbo
wiring is outside this package. Never pass raw causes, HTTP bodies or credentials
to warning/log callbacks.

Only when no OIDC provider is detected does the cache use an API key, or ask the
injected developer-session adapter. A broken/denied CI identity never silently
falls back to an API key. `apiKeysAllowed: false` rejects static keys with an
explicit error; the cache server remains authoritative for API-key authorization.
Device login and developer token endpoints follow in the CLI tickets.

## Identity sources

`CiProvider` detects GitHub Actions, Vercel, GitLab, CircleCI, Buildkite, Bitbucket,
AWS projected tokens, Azure projected workload tokens and Google environments.
`TCACHE_CI_PROVIDER` explicitly selects a shared `CiProvider` contract value;
`custom` reads `TCACHE_OIDC_TOKEN_FILE` or `TCACHE_ID_TOKEN`.

- GitHub requests a token using `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` and the
  configured audience. Missing permissions explain `permissions: id-token: write`
  and fork restrictions. Request and ID-token credentials are masked.
- Vercel rereads the current `x-vercel-oidc-token` header, then the file named by
  `VERCEL_OIDC_TOKEN_FILE`, then `VERCEL_OIDC_TOKEN`. A configured but unreadable
  file is an error. Each acquisition exchanges that source at the fixed
  `https://oidc.vercel.com/~token` endpoint for the configured audience and a fresh
  `jti`. Both credentials are masked; exchanged assertions are never cached or
  retried. No Vercel SDK or CLI login is needed in builds. Build tokens are documented by [Vercel](https://vercel.com/docs/oidc).
- GitLab reads `CACHE_ID_TOKEN`; CircleCI reads `CIRCLE_OIDC_TOKEN_V2`; Bitbucket
  reads `BITBUCKET_STEP_OIDC_TOKEN`. Configure their token audiences upstream.
- Buildkite calls the injected command adapter with
  `buildkite-agent oidc request-token --audience <audience>` as separate argv values.
- AWS EKS reads `AWS_WEB_IDENTITY_TOKEN_FILE`; Azure reads
  `AZURE_FEDERATED_TOKEN_FILE`. These are projected assertions from the cluster's
  issuer; they are not synthesized AWS/Entra tokens. Configure an appropriate
  projected audience ([Azure workload identity](https://learn.microsoft.com/azure/aks/workload-identity-overview)).
- Google calls the fixed metadata identity endpoint with `Metadata-Flavor: Google`
  and our audience, only after explicit selection or Google environment detection.
  See [Google identity tokens](https://docs.cloud.google.com/compute/docs/instances/verifying-instance-identity).
  Arbitrary metadata host overrides are not followed.

Provider readers do not establish server support. Issuer registry/guardrail profiles
for additional issuers follow in STV-451; this library never accepts a default-audience token or
changes server trust settings. Except for Vercel's explicit audience exchange, projected/file/env tokens must already have the
accepted audience. Files are bounded to 16 KiB, HTTP replies to 64 KiB, and identity
HTTP calls time out after 10 seconds. Fetch requests explicitly disable redirects.

## Exchange and DPoP

`ExchangeClient` uses `HttpApiClient` generated from the public `OidcApi`. It sends
shared redacted request types, decodes `ExchangeResponse`, and rejects wrong cache,
wrong tenant or expired replies. Errors retain only fixed actionable text. Returned
token/signature values are masked by `TokenCache`; raw response bodies never enter
errors. The response `expiresAt` is an ISO timestamp.

`DpopSignerLive` acquires a nonextractable ES256 private key per layer/job and exposes
its public JWK thumbprint. Proofs have fresh `jti`, `iat`, uppercase `htm`, `htu`
without query/fragment, optional nonce and SHA-256 access-token hash (`ath`). Keys
and tokens are never written to disk. `boundTokens` is opt-in: the current exchange
fails closed for proofs until STV-486 adds verification/binding. The signer is ready
for the proxy's later request binding; it does not claim server enforcement today.

Run `bun run --cwd packages/client-core test` for deterministic in-memory platform,
HTTP and clock tests, including cryptographic proof verification. No cloud or
credentials are required.

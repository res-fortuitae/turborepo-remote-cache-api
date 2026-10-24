# One origin and CI audiences

Set `domain` in root `deploy.config.ts` to the production hostname (without a
scheme or path) and optionally set `stagingDomain`. Alchemy attaches each to the
API Worker as a [Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
including its managed certificate. The zone must be active in your Cloudflare
account. Only configured production and staging stages attach those domains;
other stages use workers.dev. Deploy from the root only when deployment is intended.

The dashboard, Better Auth at `/api/auth/*`, cache API at `/v8/*`, and future OIDC
exchange at `/oidc/*` share this origin. Reserved API paths bypass static assets,
including SPA navigation fallback. Unknown API routes return API errors rather
than dashboard HTML. The dashboard remains the STV-466 scaffold; STV-449 owns
the OIDC exchange.

Alchemy's `Worker.URL` supplies the public origin: the attached domain, otherwise
workers.dev, or localhost in local development. Application layers receive it
through `CanonicalOrigin`. Request `Host`, `X-Forwarded-Host`, and
`X-Forwarded-Proto` do not choose it. Upload responses use it for artifact URLs.

Better Auth receives this origin as both `baseURL` and its sole explicit
`trustedOrigins` entry. Cookies stay first-party and CSRF/origin checks remain
enabled. No CORS grants are added. Access the dashboard using the canonical URL;
an alternate workers.dev hostname is not an additional trusted dashboard origin.
Register `https://<domain>/api/auth/callback/github` for OAuth in the corresponding
stage. [Better Auth's origin configuration](https://better-auth.com/docs/reference/options#trustedorigins)
controls trusted origins; CI audiences do not add trusted browser origins.

## Audiences and domain migration

The deployment Schema is exported by `@repo/deploy-config`. Existing forks may
keep importing `apps/server/src/deploy-config.ts`, which re-exports it.

```ts
import { defineDeployConfig } from "@repo/deploy-config";

export default defineDeployConfig({
  domain: "cache.example.com",
  stagingDomain: "cache-staging.example.com",
  oidcAudiences: ["https://old-cache.example.com", "https://cache.example.com"],
  jurisdiction: "default",
  limits: { artifactRetentionDays: 30 },
  features: { edgeCache: true },
  stages: { production: "production", staging: "staging" },
});
```

When `oidcAudiences` is omitted, each stage defaults to `[canonicalOrigin]`.
An explicit list applies to all stages and must be nonempty, with nonempty,
trimmed strings. Matching is exact, including case and trailing slashes; opaque
identifiers such as `urn:acme:turbo` are allowed. A JWT may have a scalar or array
`aud`. `matchOidcAudience` returns the matched configured string, in configuration
order, or none. It does not grant access: STV-449 must also enforce the trust
policy's audience/issuer/claims and record the exact match in token provenance
and audit events. The list is provided through `OidcAudience`.

Before changing domains, explicitly pin the old CI audience, optionally adding
the new one. Deploy that configuration, migrate DNS/OAuth and browser clients,
then update CI and trust policies. Remove old audience values only after clients
and policies no longer need them. Keeping an old CI audience does not require
keeping its hostname in the browser's trusted origins.

Issued cache JWTs use the current canonical origin for **both** `iss` and `aud`;
they do not use the CI audience list. `CacheTokenConfigLive` derives the settings
from `CanonicalOrigin`. After an origin change, old cache JWTs must be reissued.
The former fixed `turbo-cache` audience is rejected. The signer/verifier services
are available now; HTTP credential resolution and exchange integration remain
STV-445 and STV-449.

## Security headers

API/auth responses use Worker middleware; dashboard responses use the asset
layer's `_headers` file. Both receive `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a Permissions Policy
disabling camera, microphone and geolocation. HTTPS responses carry
`Strict-Transport-Security: max-age=31536000`; browsers ignore HSTS over local HTTP.
HSTS excludes subdomains and preload. Dashboard Content Security Policy remains
STV-474.

Cloudflare applies [asset header rules](https://developers.cloudflare.com/workers/static-assets/headers/)
only on the asset-serving path, so the Worker also adds headers to API/auth
responses, including handled errors and redirects. Bodies, streaming downloads,
status codes and multiple session cookies are preserved.

## Direct artifact upload limits

The Cloudflare zone/account plan controls request body size independently of
Workers Free/Paid: Free and Pro permit 100 MB, Business 200 MB, and Enterprise up
to 5 GB with the appropriate zone setting. Requests above that limit can receive
HTTP 413 before reaching the Worker. Check the current
[Cloudflare request limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)
when selecting a plan; a Workers Paid subscription alone does not raise the
zone's upload ceiling. Downloads have separate caching limits.

The current direct PUT API cannot bypass that ceiling. STV-492 owns the proxy's
multipart support, which will divide large artifacts into bounded requests.

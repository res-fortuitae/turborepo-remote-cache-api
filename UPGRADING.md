# Upgrading

Every stable release has a `## vMAJOR.MINOR.PATCH` section here. The release
workflow refuses to publish a tag without matching migration notes. Upstream sync
copies that version's section and the GitHub release notes into the upgrade PR.

## Unreleased

### Stateful resource retention (STV-502)

- The next authorized deployment persists deletion protection even when Alchemy
  reports no resource diff. Existing state is not protected until that deploy.
- D1, audit resources, secrets, the new `Backups` bucket and the API Worker
  (which owns Coordinator data) survive destroy, orphaning and replacement.
  Artifacts and KV remain disposable. A retained Worker stays active.
- Only stages named `preview-<suffix>` or `pr-<number>[-<suffix>]` are disposable;
  configured production/staging names always retain data. The deployed test
  harness's default `test_$USER` now retains persistent resources. Use an explicit
  preview stage for authorized disposable tests.
- The audit bucket keeps its `AuditCatalog` ID. Its Basin Catalog now uses
  `AuditDataCatalog`, fixing a duplicate logical ID that prevented the catalog
  from being registered. Review this new resource in the plan if Basin is enabled.
- Read [deletion protection](docs/deletion-protection.md) for adoption and manual
  permanent deletion. Keep the same stage, logical IDs and jurisdiction.

### Fork configuration (STV-498)

- Run `bun install --frozen-lockfile` and `bun run setup` to create
  `deploy.config.ts`. Setup preserves an existing file and can be rerun.
- Existing installations must set `stages.production` to their **current Alchemy
  stage** (previously `$ALCHEMY_STAGE` or `live_$USER`). Choosing a new name creates
  a separate deployment. Stack and resource IDs remain unchanged.
- The default retention is still 30 days and edge caching is enabled. Set
  `limits.artifactRetentionDays` and `features.edgeCache` in your config.
- Jurisdiction is selected when the R2 bucket is created. Do not change it on an
  existing bucket as an upgrade shortcut; migrating data is a separate operation.
- The composition root, `.env*`, and `.alchemy` state now live at the repository
  root; Worker code lives in `apps/server`. Preserve the existing `TURBO_TOKEN` and
  reconcile existing root state before moving files from `apps/api`.
- If you used `apps/server/deploy.config.ts`, copy its jurisdiction to the root
  `deploy.config.ts` before deploying. The old per-app config has been replaced by
  the single organization config. Restricted jurisdictions continue to disable
  artifact edge caching and return `Cache-Control: no-store`, even if
  `features.edgeCache` is enabled.
  Public GitHub App identifiers can be recorded in config; the authentication and
  secret bootstrap implementation is tracked separately in STV-499.
- If CI needs your config, commit it to the fork using
  `git add -f deploy.config.ts`. Config must contain no credentials. Optionally
  force-add org assets under `custom/`. Upstream never tracks either path.
- Review the staging plan with `bun run plan` before an explicitly authorized
  deployment. Configuring upstream sync does not deploy anything.

### Canonical origin and OIDC audiences (STV-494)

- Run `bun install --frozen-lockfile` for the new workspace dependencies.
  Deployment settings now live in `@repo/deploy-config`; the old app import
  remains compatible with existing organization configuration.
- `oidcAudiences` is optional and defaults to the stage's canonical origin.
  Before a domain change, explicitly pin old audience identifiers so existing
  CI configurations and policies can continue matching them. See
  [origin migration](docs/origin-and-audiences.md).
- Cache JWTs now use the canonical origin for both `iss` and `aud`. Tokens using
  the former `turbo-cache` audience must be reissued. CI audiences are separate.
- Better Auth uses Alchemy's public Worker URL as `baseURL` and trusted origin,
  including workers.dev and local development. Alternate hostnames do not become
  trusted origins. Update OAuth callback URLs when changing the canonical domain.
- `/oidc` and `/.well-known/*` bypass dashboard assets. API/auth and dashboard
  responses receive security headers; deployed HTTPS responses advertise one
  year of HSTS without includeSubDomains or preload. CSP remains STV-474.

### GitHub OAuth sign-in (STV-433)

- The additive auth migration adds nullable `account.github_login`. Alchemy
  applies it during the next authorized deployment. Existing rows acquire login
  metadata on their next GitHub sign-in; stable identity remains `account_id`.
- Configure `githubApp` and `GITHUB_OAUTH_CLIENT_SECRET` together. Partial
  configuration now fails planning instead of silently disabling sign-in.
  Register the stage's canonical `/api/auth/callback/github` URL and grant the
  GitHub App read-only email-address permission.
- Password authentication stays disabled. CSRF/origin checks are explicit and
  HTTPS session cookies use Secure, HttpOnly and SameSite=Lax.
- Optional magic-link integration requires an explicitly configured delivering
  Mailer layer. It remains disabled in the stock Worker pending STV-495.
- Run `bun install --frozen-lockfile` to install the new test-only emulate.dev
  dependency. See [GitHub sign-in](docs/github-sign-in.md) for setup and local checks.

### Releasing this change

Before tagging, move these notes into a section named for the chosen semver tag,
for example `## v0.1.0`. Do not tag a release until its notes, checks, and tests are
ready. No release tag is created by setup or deployment.

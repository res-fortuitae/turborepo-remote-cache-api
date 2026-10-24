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

### Releasing this change

Before tagging, move these notes into a section named for the chosen semver tag,
for example `## v0.1.0`. Do not tag a release until its notes, checks, and tests are
ready. No release tag is created by setup or deployment.

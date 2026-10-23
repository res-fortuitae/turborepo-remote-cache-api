# Upgrading

Every stable release has a `## vMAJOR.MINOR.PATCH` section here. The release
workflow refuses to publish a tag without matching migration notes. Upstream sync
copies that version's section and the GitHub release notes into the upgrade PR.

## Unreleased

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
- Keep `.env*` and `.alchemy` state in `apps/api`. Keep the existing `TURBO_TOKEN`.
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

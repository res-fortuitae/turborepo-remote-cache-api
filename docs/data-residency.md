# Data residency

Run `bun run setup` to choose the jurisdiction in the root `deploy.config.ts`
**before the first production deploy**. The organization config feeds resource
properties and a deployment-bound Worker cache policy; it is not a request
parameter or an operator environment override. Upstream never edits this file.

```ts
import { defineDeployConfig } from "./apps/server/src/deploy-config.ts";

export default defineDeployConfig({
  jurisdiction: "eu", // or "fedramp"; use "default" for automatic placement
  limits: { artifactRetentionDays: 30 },
  features: { edgeCache: true }, // residency restrictions override this flag
  stages: { production: "production", staging: "staging" },
});
```

Run `bun run check` and `bun run test`, then use the root deployment script when
ready. Invalid values fail when configuration is loaded, before resources are
registered. The stack output reports `jurisdiction` and any Basin restriction.

## Guarantees in this checkout

With the `default` jurisdiction, Cloudflare chooses artifact storage placement automatically.
The per-datacenter artifact cache is enabled when `features.edgeCache` is true. With `eu` or `fedramp`,
the artifact R2 bucket receives the corresponding jurisdictional restriction.
Artifact downloads bypass all Workers Cache API reads and writes, stream directly
from R2, and send `Cache-Control: no-store` so the application does not create
worldwide persistent artifact copies in edge or downstream caches. FedRAMP selects
Cloudflare's FedRAMP jurisdiction; it does not certify the application.

R2 jurisdiction is a storage restriction, not a request-processing boundary.
Workers still process requests worldwide, including artifact bytes, credentials,
and request metadata. Restricting that processing requires Cloudflare Regional
Services (Data Localization Suite, Enterprise), which this stack does not configure.
Logs, Alchemy's control-plane state, client-side storage, and external integrations
are not covered by this application storage setting. Review those separately.

Treat jurisdiction as immutable for a production stack. D1 permits it only at
creation; Alchemy replaces R2 buckets when jurisdiction changes. Editing this value
does not migrate existing data or purge old edge copies. An existing deployment
requires a planned migration to new resources, verification of the destination,
cache purging, and explicit retirement of old data. Do not use a redeploy as a
residency migration.

## Platform storage policy

The deployment-bound `STORAGE_JURISDICTION` setting is required and validated at
request layer construction and Coordinator lookups. Missing or invalid values fail closed. It is generated
from `deploy.config.ts`, not selected by an incoming request.

- Application R2 buckets (artifacts, backups and audit checkpoints) and D1 receive
  jurisdiction restrictions at creation.
- Every Coordinator lookup, including API-key epoch checks, uses the matching
  jurisdictional namespace before resolving a name. It stores revocation epochs,
  cache generations and audit chain heads.
- Restricted deployments omit Better Auth secondary storage entirely. Sessions,
  users and API-key records use D1; no auth records are written to KV. This adds
  D1 reads to session validation. Default deployments retain the KV cache.
- Remaining KV uses are public JWKS, project activity throttle flags, non-personal
  analytics query caches and a health probe. KV is globally replicated.
- Restricted deployments disable Basin resources and use D1 analytics and audit
  history. Audit checkpoints use the restricted bucket. The backup bucket is
  reserved for operator exports; no automatic weekly backup job is installed.

Local development still enforces the auth KV policy. The deployment-bound local
runtime flag skips Coordinator namespace restrictions only in local workerd, which
does not implement them; Coordinator state stays on local disk. Deployed Workers
always use the configured jurisdiction. Namespace selection is tested with spies
for both restricted jurisdictions.

## Upgrading an existing restricted installation

This fix does not migrate or delete deployed data. Disabling secondary storage
stops new auth KV writes but does not erase existing `auth:` entries; retire those
copies explicitly as part of an operator-controlled migration.

A jurisdiction-scoped Coordinator name identifies a **different object** from
its unrestricted counterpart. Never switch a live installation blindly: epochs
and cache generations would reset to zero and audit heads would start empty.
Quiesce traffic and snapshot all existing scope state and chain heads. Transfer
and verify those values in the destination before admitting traffic; this checkout
has no automatic state-transfer tool. Alternatively create a fresh restricted
stack, retire all old credentials/signing keys and sessions, invalidate old cache
copies, and establish an explicitly separate audit chain while preserving the old
history and checkpoints. A rollback must also preserve any epochs and generations
advanced since cutover. Retire old globally placed state only after verification.

Cloudflare's Basin restriction was verified on **2026-10-23**. Re-check the linked
documentation each release; enable Basin in jurisdiction mode only after Cloudflare
supports it and the integration has been validated.

## References

- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [D1 data location and creation-only jurisdictions](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Durable Objects jurisdictional namespaces](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Basin Catalog limitations](https://developers.cloudflare.com/basin-catalog/manage-catalogs/)
- [Workers Cache behavior](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Regional Services](https://developers.cloudflare.com/data-localization/regional-services/)

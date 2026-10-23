# Data residency

Choose the jurisdiction in `apps/api/deploy.config.ts` **before the first production
deploy**. This is a stack setting, bundled into both resource declarations and the
Worker; it is not a request parameter or runtime environment override.

```ts
import type { DeployConfig } from "./src/residency.ts";

export default {
  jurisdiction: "eu", // or "fedramp"; omit for automatic placement
} satisfies DeployConfig;
```

Run `bun run check` and `bun run test`, then use the root deployment script when
ready. Invalid values fail when configuration is loaded, before resources are
registered. The stack output reports `jurisdiction` and any Basin restriction.

## Guarantees in this checkout

With no jurisdiction, Cloudflare chooses artifact storage placement automatically.
The existing per-datacenter artifact cache remains enabled. With `eu` or `fedramp`,
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

## Integration contract for the planned platform

This baseline has no D1, Coordinator, KV, Better Auth, Basin, audit history, backup
export, or capabilities page. The shared policy in `apps/api/src/deployment.ts`
prepares those integrations; flags express permission, not service availability.
The following must be wired as those services are implemented (STV-428, STV-500,
and STV-496) before claiming platform-wide residency:

- Spread `residency.storage` into **every** application R2 bucket declaration:
  artifacts, audit checkpoints/backups, and analytics/audit catalogs. Apply the
  same options to D1 on creation; omit location hints when jurisdiction is set.
- Address Coordinator objects through the matching jurisdictional namespace:
  `namespace.jurisdiction(residency.jurisdiction)` when configured, before any ID
  creation or lookup. Use the resulting namespace consistently; the same object
  name in a different jurisdiction identifies a different object.
- Honor `allowKvSessionCache`. In jurisdiction mode, omit Better Auth's KV session
  cache and read sessions from D1. KV remains globally replicated: allow only JWKS
  and non-personal analytics caches; never personal data, session tokens, or users.
- Honor `allowBasin` before declaring any Basin Pipelines/Catalog resources.
  In jurisdiction mode, use hourly D1 counters for lite analytics, retain audit
  history in D1 for a longer hot window, and export weekly to the restricted backup
  bucket. Surface `basinDisabledReason` on the capabilities page and in doctor
  output. These fallback services are not implemented in this baseline.

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

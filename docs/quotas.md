# Organization and project quotas

Project Settings exposes organization and project quotas. Storage limits default
to the effective instance/org policy ceiling; a project may tighten them. The
organization ceiling also applies to the sum of its projects. Optional bandwidth
and request budgets use UTC calendar days. Empty daily budgets are unlimited.
Every quota configuration change is audited and requires a live administrator
session and trusted Origin. Organization settings require org-wide permission.

`GET/POST /projects/:id/quotas` and `/orgs/:id/quotas` read/update these settings.
The POST contract is `{ storageBytes, bandwidthBytes, requests,
onQuotaExceeded: "reject" | "evict-oldest" }`; numeric values are positive safe
integers or null. `GET` reports usage, reservations, effective limits and the
current eviction summary. Quota alerts at 80% and 100% are persisted for org
owners/admins and shown in the settings card, deduplicated per UTC day/threshold.

Scoped direct PUTs reserve capacity in D1 before consuming their body. One atomic
insert checks the project and organization's stored bytes plus active leases,
and daily budgets plus reserved transfers. Concurrent requests cannot independently
spend the same capacity. A concurrent write to the same hash receives retryable
429 `upload_busy` with `Retry-After: 1`, rather than 403 `over_limit`. The unique
reservation key prevents double reservation; retry after the first writer finishes. Successful completion updates the size ledger and daily
counters in the same transaction that releases the reservation. Overwrites replace
the old size rather than incrementing it. Unknown-length direct uploads reserve
the direct-request ceiling, then reconcile to the stored size. Storage-head or
accounting failures fail closed; a rejected oversized observation is cleaned up.
Direct upload finalizers release capacity on failure, defects, and Effect interruption.
A crashed request can hold a reservation for at most five minutes. Client disconnect
notification depends on the runtime; the lease bounds cleanup if no interruption arrives.

Multipart creation reserves the declared whole size with a five-minute lease,
separate from its authenticated 24-hour ticket. Each part request
renews an unexpired lease for five minutes. Expired leases cannot be revived: restart
the upload to acquire capacity again. Admission sweeps expired rows (including at
the expiry boundary); status ignores them. Completion publishes actual storage
and releases it. Abort releases it. Pre-upgrade tickets without a reservation must
be restarted. Every part/commit still rechecks authorization. Artifact operations
count toward daily request/bandwidth budgets; multipart control/part calls retain
separate existing request rate limits. Successful writes are counted transactionally;
read/failed-operation counters are observed under waitUntil and can lag briefly.
Reads remain allowed after any quota is exhausted; budgets pause writes, not reads.
`/v8/artifacts/status` reports `over_limit` when usage plus reservations exceeds a
limit; equality is healthy, though another positive increment may be rejected.
Content-Length syntax and direct upload size are checked before reserving capacity.
Opt-in legacy shared-token namespaces are outside org/project quota accounting.

Reject is the default. Optional evict-oldest queues a durable job when storage
admission fails. Writes stay paused while it runs, including through JWT refresh.
Admission during eviction returns 429 `upload_busy` if capacity is otherwise
available; pending maintenance alone does not set `over_limit`.
The minute cron scans one 100-object R2 page at a time, retaining only the oldest
100 candidates by provenance `uploadedAt` (native upload time is the fallback).
It finishes the entire scan before deleting, so lexicographic hash order never
stands in for age. It removes at most 25 objects per tick, checks ETags, skips only hashes with
live reservations, and invalidates edge-cache generations. Scans repeat until
both project and org storage are below 90%, or no artifacts remain. Inventory
reconciliation skips active eviction jobs. Completion and one audit summary commit
together with `evictions`/`evictedBytes` analytics counters. Daily bandwidth/request
limits cannot be repaired by deleting storage; they reset at midnight UTC.

R2 and D1 have no shared transaction. Existing inventory drift and interrupted
platform writes remain eventual-consistency limits; inventory reconciliation
repairs them. An exhausted empty prefix clears its stale size ledger. Quotas are
an admission budget over the ledger and active reservations, not a claim that R2
is transactionally coupled to D1. Large inventories may need many bounded ticks.

Contention is a transient cache write failure, not a credential-wide quota disable.
Turbo compatibility must be checked against local fixtures when changing this status;
The local real-binary probe confirms Turbo 2.11.10 sends one PUT on 429 and
leaves the task successful; it does not automatically retry that publication.
429 carries a retry hint for clients that support it. Task output remains usable even when cache publication fails.

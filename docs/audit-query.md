# Audit query and export API

Use a live, non-impersonated session. All responses are `Cache-Control: no-store`.

- `GET /orgs/:id/audit` requires `audit:read` for that organization.
- `GET /instance/audit` requires the live instance auditor, admin or owner role.
- Append `/export.csv` or `/export.jsonl` to either path to stream an export.
  Org exports require `audit:export`; instance audit roles can export instance logs.

Every request requires UTC ISO `from` and `to` timestamps (`from` inclusive, `to`
exclusive). Optional exact filters are `actor`, `action`, `target`, and `outcome`
(`allow`, `deny`, `error`). Identifiers use letters, digits, `_`, `:`, and `-`,
up to 128 characters. Actions additionally permit `.`. This grammar accommodates
existing Better Auth ids and domain action names while excluding SQL syntax.
Unknown and repeated query parameters are rejected.

Reads accept `limit` (1–100, default 50) and an opaque `cursor`. Pass the returned
`nextCursor` with the same scope and filters. Results sort newest first by event
time and ULID; pagination never uses offsets. Cursors are filter-bound, not secrets
or authorization credentials. Every request rechecks authorization.

D1 and Basin results are merged by time/id and deduplicated by event id. D1 wins
when an event appears in both. The fixed Basin query includes time, scope, exact
filters and a maximum 101-row limit. It reads the entire requested window so
standalone denials (which bypass D1) also appear. Pipeline delivery is asynchronous;
a fresh request can see events that were not yet visible during an earlier page.
A pagination session is not an immutable snapshot. Existing D1 chain heads and
unexported old events are included even beyond the normal hot window.

Exports use pages of 100 events with backpressure and emit an `audit.export` event
before sending the body. CSV quotes every field and neutralizes spreadsheet formula
prefixes; nested fields are JSON. JSONL preserves the event structure. Export events
describe the requested export, not proof that a client consumed the full stream.
The first page is fetched before headers; later failures terminate the stream, so
downloaders must treat interrupted exports as incomplete. Export filters cannot
include a cursor or limit; use the read endpoint for resumable pages.

## Basin configuration

The existing Alchemy audit catalog supplies the account id and bucket name to the
Worker. `BASIN_SQL_TOKEN` remains a separate root environment secret, provisioned in
Secrets Store and read only at runtime. Supply an audit-catalog-scoped query token;
never reuse `BASIN_CATALOG_TOKEN`. Credential creation and permission selection are
operator-owned, as described in [Basin infrastructure](basin-infrastructure.md).
The endpoint follows Cloudflare's [Basin SQL REST API](https://developers.cloudflare.com/basin-sql/query-data/).

D1-only installations query retained D1 data without a remote dependency. When
Basin history is enabled, missing credentials or a failed query returns 503 instead
of silently dropping history. REST responses are bounded to 8 MiB and queries have
a 30-second timeout. No user-supplied SQL, endpoint, table, or projection is accepted.
Tests use migrated SQLite and a simulated Basin HTTP transport; deployment/real
catalog validation requires an explicitly authorized deployment and credentials.

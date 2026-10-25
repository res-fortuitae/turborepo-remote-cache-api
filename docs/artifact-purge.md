# Upload provenance and incident response

Every upload stores server-assigned `uploadedAt`, `credentialType` and
`credentialId` in R2 custom metadata. API keys identify the key; developer cache
JWTs with a `user:<id>` subject also store `userId`. Cache JWTs can carry a signed
`uploadIdentity` with `provider`, `repositoryId`, `ref`, `jobWorkflowRef`,
`commitSha` and `runId`. Only the issuer supplies this identity; the verifier
validates it before the artifact API uses it. Each field is bounded to 128
characters. OIDC exchange integrations should copy these fields from verified
claims when issuing a cache JWT. Older tokens remain valid and simply omit
unavailable identity fields. Client headers cannot set provenance. Provenance
is not returned in artifact download headers.

Successful uploads also emit the same provenance through `ArtifactOpEmitter`;
the current D1 upload-operation adapter persists it in `artifact_operation`.
This background emission is best effort, while R2 metadata is authoritative.
M7 can export these server-observed operations alongside other `artifact_ops`.

## Preview, review, confirm

Revoke compromised credentials first. Use the dashboard's **Purge artifacts**
page (`/#purge`) with an existing fresh signed-in session, or the management API:

1. `POST /projects/:projectId/purges` with a JSON filter creates a durable dry run.
2. `GET /projects/:projectId/purges/:id` returns progress, count and byte total.
3. Once `state` is `ready`, review the result and
   `POST /projects/:projectId/purges/:id/confirm` to queue permanent deletion.
4. Poll the same job until `complete`. Never treat HTTP 202 as completed deletion.

A session with project administration (`update`) permission is required for all
operations. Cache bearer credentials cannot invoke them. Mutations require the
canonical `Origin`, and a fresh passkey proof when policy requires one.

Filters support `hash`, `credentialId`, `userId`, `provider`, `repositoryId`,
`ref`, `jobWorkflowRef`, `commitSha`, `runId`, `since` and `until`. All supplied
fields must match. Times are ISO timestamps with inclusive bounds. An empty
filter or invalid/reversed range is rejected. Missing provenance never matches
an uploader filter; older artifacts can still be selected by hash or upload time.
The R2 upload timestamp is used for time comparisons.

```json
{
  "jobWorkflowRef": "acme/web/.github/workflows/build.yml@refs/heads/main",
  "since": "2026-10-25T00:00:00Z"
}
```

The preview captures object versions uploaded no later than its creation time.
It expires 15 minutes after scanning finishes. A job supports up to 1,000 matches
and a 700 KB manifest; `too_large` requires a narrower filter, such as a shorter
time range. Objects replaced since the preview are skipped. `removed` and
`removedBytes` include selected versions already absent on a retry, making
checkpoint retries stable. These are purge outcomes, not a count of R2 delete
API calls.

A minute cron scans 100 objects or deletes 100 selected objects per job per tick,
for up to ten jobs. D1 stores checkpoints and a two-minute lease prevents normal
concurrent ticks from duplicating work. Failed jobs remain pending and retry on
later ticks; permanent storage/audit failures require operator recovery. Job
records and upload-operation rows are retained in D1; budget and archive this
incident history with your audit data. No deployment is performed by these APIs.

During confirmed jobs, project uploads return `409 purge_in_progress`. Uploads
also read the live generation before and after writing; an in-flight upload
crossing a purge generation is removed and fails with `409 purge_race`. Reads
continue. Each deleted batch bumps the project generation, invalidating edge
copies across locations within five seconds. Existing downloads can finish.
Do not manually clear a pending job to resume writes until recovery is complete.
Audit intent precedes deletion; every preview, confirmation and batch checkpoint
commits an audit event and the job state in one D1 batch, with filters and totals.

## CLI

Until the device-login credential store is implemented, supply an existing
session cookie privately in `TCACHE_SESSION_COOKIE` (never commit it or pass it
as a command-line argument). `TURBO_API` selects the server. The API-key token in
`TURBO_TOKEN` does not grant management access.

```sh
bun packages/cli/src/bin.ts admin purge PROJECT --filter '{"runId":"123"}'
bun packages/cli/src/bin.ts admin purge PROJECT --job JOB_ID
bun packages/cli/src/bin.ts admin purge PROJECT --job JOB_ID --confirm
```

The command prints the same JSON summary as the API and defaults to a dry run.
It requires HTTPS except on loopback and refuses credential-bearing redirects.
Anomaly handlers can propose the same `PurgeFilter` and call `IncidentPurge.preview`;
confirmation remains explicit. Automated anomaly policy and its UI follow STV-490.

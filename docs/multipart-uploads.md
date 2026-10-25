# Large artifact uploads

Direct Turbo uploads are limited by the serving Cloudflare zone. This instance
uses a conservative 100,000,000-byte ceiling on Free/Pro, workers.dev and unknown
plans, or 200,000,000 bytes for an eligible Business/Enterprise custom domain.
Cloudflare may reject a request before it reaches the Worker. Direct uploads
that reach the Worker above its ceiling return `413` with a message directing
the caller to `tcache exec`. Upload failures with status 413 also enter the D1
server-observed upload-operation history, including credential provenance.

Multipart uploads travel through the Worker API. They preserve artifact signing
tags, duration, SHA and dirty-hash metadata; presigned R2 PUTs are not used.
Downloads continue to stream without a request-body ceiling. Artifacts larger
than 512,000,000 bytes bypass the Workers Cache API (including its body tee).

## Limits and migration

`limits.maxDirectUploadBytes` in root `deploy.config.ts` can lower the direct
request ceiling; it cannot exceed the detected zone ceiling. The deployed Worker
receives it as `MAX_DIRECT_UPLOAD_BYTES`. `limits.maxArtifactBytes` is a separate
object ceiling (default 10,000,000,000 bytes), supplied as `MAX_ARTIFACT_BYTES`.
Project limits and effective organization/instance quota policy can tighten the
object ceiling further. These are per-object admission bounds, not aggregate
storage quotas (STV-476).

Older project rows may store the old 100/200 MB limit explicitly. A project admin
must raise that project's `maxArtifactBytes` through its settings API before it
can accept large multipart artifacts. Existing root config remains valid. No
project settings are automatically changed.

With 64 MiB parts and a maximum of 10,000 parts, this protocol caps objects at
640,000 MiB even if a higher object ceiling is configured. Every nonfinal part
has exactly 64 MiB; the last has the exact remaining byte count. A
`FixedLengthStream` enforces actual bytes at the R2 boundary without buffering.

## Protocol

Every endpoint requires a currently valid scoped cache JWT or API key with
write permission. Legacy shared tokens cannot use this API. Scope, tenant,
current project policy and per-credential rate limits are checked on **every**
request. Creation and parts do not grant permission to complete later.

1. `POST /v8/x/uploads`, JSON `{ "hash": "abc123", "size": 150000000 }`, with
   `x-artifact-duration`, `x-artifact-tag`, `x-artifact-sha` and/or
   `x-artifact-dirty-hash`. Returns `201 { id, partSize, expiresAt }`.
2. `PUT /v8/x/uploads/:id/parts/:number`, streamed bytes with the exact
   `Content-Length`. Returns `{ partNumber, etag }`. Part numbers start at 1;
   a retry replaces that same part.
3. `POST /v8/x/uploads/:id/complete`, JSON
   `{ "parts": [{ "partNumber": 1, "etag": "..." }, ...] }`, ordered and complete.
   Returns 202 only after R2 commits and post-write authorization succeeds.
4. On failure, `POST /v8/x/uploads/:id/abort` (204). Abort still checks the
   original credential/tenant but permits an expired or purged handle so cleanup
   can run. R2 lifecycle aborts unfinished uploads after one day as a fallback.

The opaque ID is a signed 24-hour ticket. It binds the R2 upload ID, organization,
project, hash, credential ID, expected size, generation and server provenance.
Treat it as request data; it never replaces the bearer credential. Rotating the
Better Auth secret invalidates outstanding tickets. Refreshing to a new cache
JWT ID requires restarting that upload. Revoked/expired bearer credentials
cannot continue or abort; the R2 lifecycle cleans their unfinished uploads.

The upload metadata is assigned when creation is accepted. Completion replay
with the same ticket is idempotent while that committed object version remains.
The server rejects missing, duplicate, unordered or extraneous parts. R2 verifies
their etags. If project policy tightens or a purge changes the generation, the
caller must abort and restart. Project deletion/archive and purge races are
checked again after completion; a failed recheck removes that upload's object.
Success evicts the local edge entry and emits the upload operation/provenance.

## Proxy integration

`@repo/client-core` exports `uploadArtifact({ server, token, hash, artifact,
headers, signal })`. `artifact` is a replayable Blob/file, such as a staged file
on disk. Artifacts below 64 MiB use a normal PUT; larger ones use the protocol
above. At most four parts are in flight; each part and completion retry transient
network/5xx/429 failures up to three total attempts. Retry-After is honored up to
60 seconds. Permanent failures cancel outstanding parts, wait for them to settle,
and attempt abort with a separate cleanup timeout. The token callback runs for
every request. Credential-bearing redirects are refused.

The transport forwards only artifact metadata headers and sets its own bearer
credential. A localhost proxy should spool Turbo's incoming body to a temporary
file and remove it in `finally`; it must not buffer a whole artifact in RAM.
The local `tcache exec` command and proxy lifecycle are delivered by STV-485;
this ticket supplies their shared upload transport. Direct/env-mode Turbo cannot
split a PUT itself.

## Validation

`bun run test` includes real Turbo miss/upload/hit/restore round trips through a
local disk-backed proxy at 50 MB, 150 MB and 1 GB. The generated payloads are
incompressible, so compression cannot hide the multipart path; restored files
are compared by SHA-256. HTTP tests cover authorization, handle tampering,
metadata, completion replay, abort and purge races. The production R2 adapter
also runs against local workerd/Miniflare to verify streaming metadata and actual
body-length enforcement. These tests use local disposable data; no deployment
or cloud credentials are required.

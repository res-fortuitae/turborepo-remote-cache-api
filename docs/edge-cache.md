# Artifact edge cache

Downloads fill the edge cache from a second R2 read under `waitUntil`. The client
receives the original R2 stream. No tee connects their consumption rates, so a
fast cache writer cannot accumulate the client's unread artifact in memory.
This adds one R2 read on eligible misses. Cache-fill errors remain best effort;
objects above 512,000,000 bytes bypass filling. Authenticated responses keep
`Cache-Control: no-store`; only internal edge copies have a one-hour TTL.

Keys encode the whole storage prefix in a segment beginning with `p`. This keeps
legacy `.` and `..` teams distinct after URL normalization and separates slashes
from literal percent encodings. The key change intentionally cold-starts caches.

The retention sweeper invalidates project generations before advancing its page.
Native R2 lifecycle deletes have no callback and can leave cached copies readable
for the remaining TTL, at most one hour. See [project retention](projects.md).

## STV-790 diagnosis

On base a8bbb5d, regression tests failed for dot-only team isolation, missing
retention invalidation, and a client stream whose `tee` method throws. The fixed
handler never calls that method and uses two origin reads on a cold download.
A pinned local Miniflare/workerd probe drained all 33,554,432 bytes of a native R2
tee while the client branch remained unread. This demonstrates buffering, not
measured RSS or an isolate OOM. A 300 MB stress run was not performed.

Current [Cloudflare streams documentation](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestream/)
and [workerd stream notes](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/streams/README.md#tee-behavior)
describe slow-branch backpressure; the local native R2 observation means this
application must not rely on that description for memory safety.

Generation changes propagate to other isolates within the Coordinator client’s
five-second state-cache window; the invalidating isolate updates immediately.

# Cache anomaly detection

STV-490 adds project-scoped signals independent of the optional Basin analytics
pipeline. Detection defaults to enabled, alert-only. It is a heuristic, not proof
of compromise: a malicious trusted job can request a valid OIDC token.

Verified write exchanges learn issuer, repository ID, ref and reusable workflow
identities. The first value trains a baseline; a new value thereafter records an
incident before token issuance. Required DPoP is verified first. Commit/run IDs
are deliberately excluded. Successful uploads learn the same bounded identities.
Missing provider-specific normalized claims cannot be inferred; those dimensions
are skipped. An upload's request headers never establish identity.

Successful uploads count bytes, writes and signature tags. Re-uploading a hash
in persisted upload history signals an overwrite (including a legitimate upload
race or re-upload after retention). An unsigned upload signals after at least
20 signed uploads in prior hours with no unsigned uploads. After 24 active hourly
buckets, writes in a previously inactive UTC hour signal unusual timing.

A minute cron evaluates up to 100 closed hourly buckets per invocation. At least
three prior buckets establish a volume baseline; writes must exceed both the
configured minimum and the multiplier of the average of up to 168 previous
recorded hours. Twenty exchanges with at least 50% denials trigger a signal.
Successful write exchanges from more than the configured IP count in an hour
trigger another. Only verified assertions for existing projects contribute;
invalid assertions cannot assign an attacker's traffic to an arbitrary project.
IPs are SHA-256 digests, retained in the short-lived baseline, and never emitted
in alert detail. Baseline cardinality is capped at 200 values per dimension.

Incidents and optional containment intent are committed with an audit event.
Signals coalesce per project/code/detection hour. Overlapping invocations may
append duplicate audit/delivery attempts, but share one incident/notification
ID. Baselines retain eight days. Incident/audit evidence is retained. The cron
retries pending revocation and delivers org owner/admin notifications using the
existing Alerts service (persistent console notification plus configured email,
and a webhook when the host supplies one). Email failure retains the console
alert; delivery is at least once. No webhook URL is accepted from project input.

## Management

`GET /projects/:id/anomalies` returns config, effective write fence and the latest
100 incidents. `POST` requires a fresh authorized management session, same origin,
no impersonation, and configured instance-admin passkey proof. Example body:

```json
{
  "enabled": true,
  "readOnlyOnAlert": true,
  "revokeOnAlert": true,
  "minHourlyWrites": 100,
  "volumeMultiplier": 5,
  "maxExchangeIPs": 20,
  "resume": false
}
```

Read-only containment rejects live cache writes and new write exchanges while
allowing reads. Revocation bumps the project's Coordinator epoch, invalidating
existing JWTs within the existing five-second epoch-cache bound. API keys still
obey the write fence but are not deleted. Pending revocation itself fences writes
until a retry succeeds. Revoke-only containment permits new credentials after
the epoch bump; combine it with read-only mode to keep the project quarantined.
In-flight writes past their final authorization check can still finish.

After investigation, set `resume: true` to clear read-only containment. A pending
revocation must finish first. Disabling detection does not silently lift an
existing fence. Configuration/resume operations are audited. Legacy shared-token
traffic has no project identity and is excluded. Failed background observations
are logged and do not turn a completed upload into a failed response; gaps can
therefore occur during database outages. This is detection, not a durable
per-upload enforcement ledger.

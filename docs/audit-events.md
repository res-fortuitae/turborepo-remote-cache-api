# Audit event coverage

Application-owned project/grant/trust-policy, credential, device-decision, instance
policy and organization administration writes use `AuditLog.commit`: their state
and chained event commit in one D1 batch. OIDC exchange records allow and deny.
Authorization denials use `recordStandalone`, going directly to the stream when
configured and durably into D1 in fallback mode.

Better Auth's D1 adapter cannot join that batch. `@repo/auth` wraps its adapter,
including sequential transaction callbacks, for user/session/account, organization,
member/invitation/team/team-member/dynamic-role, API-key, passkey and device-code
writes. This covers plugin paths that lack paired organization hooks. Existing
organization hooks continue to enforce policy; duplicate after-only events were
removed. Routine session refresh and active-organization bookkeeping are excluded.

Before a write, an immutable event with `metadata.status = pending` and a mutable
intent row commit together. Failure blocks the auth write. Afterward, one terminal
`committed` or `aborted` event is appended with the same `intentId`; the pending row
is removed atomically with a unique resolution receipt. Neither chained event is
modified. There is one terminal event per adapter mutation/target; a multi-row
operation (such as creating an organization and its owner membership) produces
separate target events. Application-level events describe additional domain writes.

The five-minute reconciler inspects at most 100 intents older than five minutes.
Creates are checked by their preassigned random id, deletes by absence, updates by
a SHA-256 digest of changed fields. Pending state stores field names and digests,
never raw credentials or update values. Request identity and HTTP context come from
Better Auth's request-local context. Team-member org scope is resolved through its
team before deletion. Bulk operations are bounded to 1000 matching targets.

Reconciliation observes current state, not historical proof: a later overwrite or
delete can make an earlier successful mutation appear aborted. The immutable intent
remains evidence that the mutation was attempted; operators should correlate its
request id and subsequent events. A confirmation failure can return an error after
the auth write committed; clients must inspect state before retrying. Failed writes
can remain pending until the next reconciler run. Resolution receipts are retained
for idempotency. No deployment is required for the unit tests.

First-user ownership bootstrap is also an application-owned batch. Its
`instance.owner.bootstrap.checked` event records the conditional ownership check,
including when an owner already exists. An audit insert failure prevents the role
change. Known failed update guards resolve as aborted; a successful single-row
adapter result confirms the write without a second state read.

## Outbox recovery

Export acknowledgements use at most 99 event IDs plus one timestamp per D1
statement, within D1's 100 binding limit even for larger drain sizes. New events
are schema-validated before recording or standalone delivery.

A persisted payload that fails schema validation is quarantined with
`audit_event.export_error`. The drain logs the row ID and quarantine count, then
continues exporting healthy rows. Its return count includes quarantined rows so
scheduled drains continue past a full malformed batch. Quarantine leaves the
payload, hash, chain position and `exported_at` unchanged; these rows are never
pruned and remain available to integrity verification and operator investigation.
After investigating and repairing the underlying problem, an operator can clear
`export_error` to retry delivery. Do not rewrite hashed payloads to bypass
validation. Sink delivery remains at least once, and consumers deduplicate by ID.

## Integrity verification and checkpoint retries

Daily checkpoints now include an optional `exportedPrefix`: a contiguous exported
sequence watermark and the maximum event timestamp in that prefix. The locked
checkpoint store retains this evidence outside D1. Verification accepts a missing
prefix only when that evidence covers it and its maximum timestamp is older than
the configured audit retention window. A missing checkpointed row needs the same
evidence. Interior gaps and truncated heads remain errors. The first surviving
row's previous hash is compared with a checkpoint at its preceding sequence when
available. Row `org_id` and `ts` must match the hashed canonical payload.

Older checkpoints remain readable but contain no export evidence. Already-pruned
legacy history therefore produces a mismatch rather than an unsupported integrity
claim. Export evidence records D1's acknowledged delivery, not an independent
query of Basin: historical Iceberg verification remains unimplemented. Evidence
cannot be reconstructed from missing rows. A failed checkpoint or an export that
finishes after that day's snapshot can likewise leave insufficient evidence for
later pruning; verification conservatively reports that history as unverifiable.
A D1 writer who tampers before a checkpoint is created remains outside the trust
provided by that checkpoint, as with the original head snapshots.

Each scope's first successful UTC-day snapshot is immutable. Identical create-only
store retries succeed; conflicting content fails. Daily retries reuse existing
snapshots even if new events were appended and attempt the remaining scopes.
Checkpoint write failures do not skip verification or pruning: the daily job logs
the checkpoint error and returns it after both have been attempted. Verification
and pruning failures also propagate. These rules supersede the initial first-row
trust assumption described in ADR-0005.

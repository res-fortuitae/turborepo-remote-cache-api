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

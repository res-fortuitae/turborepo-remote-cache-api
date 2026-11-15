# Access revocation (STV-787)

Member and team deletion through Better Auth delete their project grants in the
same D1 batch as the principal. Adapter-level handling covers remove, leave and
bulk deletion. Organization scoping preserves grants in other organizations.
Each principal is atomic; bulk operations may partially complete across principals.
Audit intents precede the batch and existing reconciliation covers lost confirmations.

Developer JWTs bind to the membership row ID, checked in D1 at every verification.
Removal rejects outstanding tokens on the next verification; re-invitation creates
a different membership and cannot revive them. Existing developer JWTs without
this binding fail closed. CI tokens continue to use org/project epochs. D1 lookup
failure fails closed. Already-authorized requests can finish. Role or team-membership
changes within an existing organization membership retain the JWT's issued scope
until expiry (at most the configured maxTokenTtlSeconds, 900 seconds by default);
use project/org epoch revocation for urgent containment of those changes.

API-key verification reads current D1 key state and effective policy each time.
KV remains only a usage-sampling throttle. Organization-owned API keys deliberately
survive the issuing user's departure; revoke the key itself to remove access.
Device sessions can only mint authorized developer tokens and inspect/end their
session, plus authorized read-only organization/project discovery for CLI linking. Browser sessions retain normal access.

## Offline upgrade cleanup

No cleanup is automatically run and no deployed database was accessed for this change.
Before rollout, take a backup, quiesce membership/grant writes and review/run
`packages/db/scripts/access-revocation-cleanup.sql` against the intended database
using your normal maintenance procedure. It removes grants whose user is no longer
an org member or whose team no longer exists in that org. It also invalidates all
sessions: older device sessions cannot be distinguished safely from browser ones.
Also clear the session secondary-storage namespace during the maintenance window
so a cached old session cannot survive the D1 cleanup. Users must sign in again. Repeating the SQL is safe.

Historical grants for users already re-invited cannot be distinguished from deliberate
new grants; review those against membership history and explicitly remove any stale
grants before resuming traffic. This is an operator review requirement, not an
automated inference. The script is outside additive migrations because it deletes
access data; review and schedule it independently. It must not be run as part of
ordinary tests, development startup or CI.

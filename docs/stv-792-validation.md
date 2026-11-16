# STV-792 purge safety

Base: e8c7352. Local validation on 2026-11-15 UTC.

## Findings and design

- F1 confirmed in source: the project ID was arbitrary text and the confirm
  button immediately sent the destructive request. Replace it with the current
  organization's project list and a typed-slug confirmation showing project,
  organization, matched count and bytes. Reset the entire form on organization
  changes, and check list membership before every request.
- F2 reproduced with the service test: a mismatched project scope claimed and
  released the foreign job lease. Validate scope before claiming, then re-read
  under the lease to retain state/concurrency validation.
- F3 ruled out for the reported failed-checkpoint scenario. Job persistence and
  audit commit atomically; counters are absolute checkpoint totals. A failed
  post-delete save leaves the old offset and totals. Reprocessing absent objects
  advances that checkpoint exactly once. Counting only non-null heads would
  undercount deleted-but-uncheckpointed objects. Preserve this behavior and add
  fault injection after an earlier committed batch (105 objects, 1,050 bytes).
  Cache generation invalidation on every deletion batch remains unchanged.

## Validation

- Scope regression failed on base: observed claim and release instead of no
  lease operations. Passes after fix.
- Retry fault-injection regression passes on base and after fix.
- Clean-environment runs with TURBO_CACHE=local:rw:
  bun run check; bun run test; bun test packages/artifacts/src apps/server/tests.
  Direct suites: 205 passed, 41 skipped, zero failures.
- Browser interaction against a temporary loopback-only fixture on port 47922
  rendering the real PurgePage and ConfirmDialog:
  only current-org options; dialog opening sends no confirmation request;
  name/org/5 artifacts/100 bytes displayed; slug gates submission; exactly one
  confirm request after typing; switching org clears selection/preview/dialog.
  Injecting a foreign option into the DOM is rejected before a request.
- No existing dashboard component DOM test harness. The browser fixture was
  removed after verification. This is fixture-based UI verification, not a
  full authenticated local Worker browser journey or a deployed-service test.

## Isolation and integration

No deploy/destroy, live requests, deployed tests or remote cache used. Root has
only .env.example; validation environment was reduced to PATH, HOME,
TURBO_CACHE=local:rw and telemetry opt-out. Live-test credentials/opt-in absent.
Workflow triggers inspected: validation and compatibility run on push/PR;
validation configures deployed remote cache. Commit includes [skip ci].

Potential overlap with STV-791: packages/artifacts/src/incident.ts and its test.
Only confirm scope ordering changed in production service code; maintenance and
retention deletion were not modified.

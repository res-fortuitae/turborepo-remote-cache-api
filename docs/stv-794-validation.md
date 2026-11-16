# Validation integrity (STV-794)

The validation workflow checks the committed Action bundle before the build can
replace it. This check runs directly, outside Turbo caching. The workflow order
has a local regression test. Both a source change without rebuilding and a
hand-edited bundle must fail this step.

Server acceptance tests execute the Action bundle, CLI source and root Turbo
binary. `apps/server/turbo.json` retains the shared test inputs and adds Action
source/bundles, CLI and client-core source, root package metadata and the lockfile.
The lockfile and package metadata capture the installed Turbo version; generated
node_modules contents are not hashed. Dependency installation must remain frozen.
The hash regression test creates temporary inputs and verifies server test hash
changes without running any cache service.

The boundary checker now scans root sources as well as workspaces and recognizes
literal `new URL(path, import.meta.url)` references and `mock.module` calls. Root
composition uses public package exports; existing private adapter references and
repository asset reads have explicit file/path exceptions. New private reads need
reviewed exceptions, rather than blanket permission for tests or scripts.
Computed URL paths and aliases of `mock`/`URL` are outside this static check's
coverage; it is a dependency guard, not a security sandbox.

## Local evidence

On the prepared 6a348af base, all three new boundary fixtures failed. The original
server test hash stayed unchanged after a CLI-only edit. A hand-edited committed
Action bundle failed `check:bundle`, then passed after a build erased the evidence.
After the fixes, Action source, Action bundle and CLI edits each changed the server
test hash. Temporary mutations were restored, including the committed bundles.

Validation uses `TURBO_CACHE=local:rw` with inherited TURBO/TCACHE/Alchemy/Cloudflare
environment settings removed. This checkout had no inherited such settings and no
local remote cache configuration or environment files. Acceptance servers bind
local ports and create disposable state. Live suites are skipped. No deployed
services, CI dispatch, deployment or destruction are part of this validation.

Workflow triggers were inspected: validation and compatibility run on PRs/main;
binary builds also run on PRs; release is tag-triggered; preview is manual and
runner lifecycle is reusable/manual. The implementation commit includes `[skip ci]`
to suppress PR validation that would otherwise authenticate to the deployed cache.
GitHub workflow execution itself has deliberately not been tested.

Final local results: `bun run check` passed; `bun run test --force` passed all
41 Turbo tasks with zero cached tasks (including 395 shared configuration tests).
Server tests reported 188 passed, 41 live tests skipped, zero failures. The focused
boundary/order/hash suite passed all 20 tests. Validation used Bun 1.4.4 on this
machine; CI pins Bun 1.4.3, so exact pinned-runtime workflow execution is unverified.

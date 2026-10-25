# Turbo Cache GitHub Action

A Node 24 JavaScript Action, with `@repo/client-core` and its runtime dependencies
bundled in `dist/`. It does not install/download a CLI, Bun, npm packages or code at
runtime. Proxy mode is the default and DPoP-binds exchanged cache tokens.

Pin a reviewed full commit SHA (replace the placeholder; do not use a moving branch):

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@<reviewed-full-commit-sha>
  - uses: StvyaSharma/turborepo-remote-cache-api/packages/action@<reviewed-full-commit-sha>
    with:
      api: https://cache.example.com
      team: org_id
      project: project_id
      mode: proxy
      strict: "false"
  - run: bunx turbo run build
```

Inputs `api`, `team`, `project` are required. `api` is the cache origin and requested
OIDC audience; instance config/policies must accept it. Save a GitHub trust policy
using immutable repository/owner IDs and safe write restrictions as documented in
`@repo/oidc`. No cache secret is needed. GitHub must grant `id-token: write`; fork
pull requests often cannot mint an accepted identity and should receive read-only
or no remote access under the server policy.

`mode: proxy` starts the shipped Node daemon, waits for readiness, masks credentials
and exports TURBO_API/TURBO_TEAM plus a random per-session TURBO_TOKEN. The real
cache token and nonextractable ES256 key stay in daemon memory. Each upstream cache
request/retry carries a fresh proof. Refresh runs while subsequent steps execute;
requests never trigger an exchange. The authenticated post-step stops the daemon,
removes its private state directory and adds hit/miss/upload/error/retry counts to
the job summary. State uses a unique private temp directory and mode 0600 file;
only the loopback environment is stored, never the real cache token or private key.
All daemon standard streams are detached from the runner; fixed startup failures
travel over IPC. Token masks travel to the parent before it disconnects. Refreshed
credentials never enter a log channel after the main step has exited.

`mode: env` exchanges once, masks the returned token and optional signature key
with `core.setSecret`, and exports the real credential for later steps. No daemon
is started. Lifetime remains bounded by policy, instance, signer and CI assertion
expiry; a long job cannot refresh Turbo's captured env token. Binding-required
policies refuse this mode. Optional TURBO_REMOTE_CACHE_SIGNATURE_KEY is exported
when the server supplies it; actual signature-key issuance remains STV-475.

On authentication/setup failure, the default warns and exports `TURBO_CACHE=local:rw`,
clears remote credentials and points TURBO_API at a closed loopback port. Explicit
Turbo command-line cache flags override its environment; avoid forcing remote-only
mode when requesting fail-open behavior. `strict: true` marks the step failed.
Inputs/errors never include raw HTTP bodies, tokens or upstream exception causes.

## Runner support

The local integration suite executes the shipped bundles under Node 24, exits the
main process, uses the proxy from another process, then runs post and confirms the
listener and state are gone. GitHub runner [job cleanup source](https://github.com/actions/runner/blob/main/src/Runner.Worker/JobExtension.cs)
places orphan cleanup at finalization. Hosted Linux/macOS/Windows certification and
composite/reusable/container/self-hosted probes are supplied by STV-452; they still
need execution in those environments. Do not assume loopback crosses job/container
network namespaces. Use `tcache exec -- turbo run build` within a single step on
runners that cannot preserve detached processes; env mode is the unbound fallback.

## Building and reviewing

Use Bun 1.4.3 and the committed lockfile:

```sh
bun install --frozen-lockfile
bun run --cwd packages/action build
bun run --cwd packages/action check:bundle
bun run --cwd packages/action test
```

`build.ts` bundles main/daemon/post and retains full third-party license/notice
texts from the build graph. Commit generated files with source. `check:bundle`
rebuilds in memory and rejects stale bundles/licenses. Tests intentionally require
Node 24, the Action's actual runtime; Bun remains the workspace script/test runner.
Versioned immutable release tags and provenance/attestations belong to the later
distribution/release scope (STV-488/480); this PR publishes no release/tag.

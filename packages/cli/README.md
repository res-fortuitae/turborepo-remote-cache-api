# @repo/cli

Run with Bun: `bun packages/cli/src/bin.ts <command>`. Effect CLI provides command
validation, help, completions and wizard support. Single binary distribution is
tracked in STV-488. These authentication commands
use `@repo/client-core`; no Worker implementation is imported.

```sh
# Configure TCACHE_API, TCACHE_TEAM, TCACHE_PROJECT and CI OIDC as in client-core.
bun packages/cli/src/bin.ts exec -- turbo run build
bun packages/cli/src/bin.ts exec --strict -- turbo run build
bun packages/cli/src/bin.ts env --format shell
bun packages/cli/src/bin.ts proxy --state "$RUNNER_TEMP/tcache-session.json"
# In another process/step, read the private JSON state and set its TURBO_* values.
bun packages/cli/src/bin.ts proxy-stop --state "$RUNNER_TEMP/tcache-session.json"
```

Flags before `--`: `--api`, `--team`, `--project`, `--audience`, `--strict`,
`--unbound-tokens`. Config precedence remains flags > TCACHE_* > .turbo-cache.json.
Proxy/exec use DPoP by default; `--unbound-tokens` explicitly opts out for legacy
servers or policies permitting bearer tokens. Env mode always requests an unbound
token, so policies requiring binding refuse it. Static API keys remain bearer tokens.

Exec binds a random loopback port, passes a random per-session token to the child,
streams requests/responses, preserves Content-Length and HEAD, and closes the
listener when the child exits or is signalled. The real cache token stays in memory.
A per-process maintenance loop checks refresh every second, with client-core's
coalescing, expiry margin and failed-acquisition cooldown. Requests only peek at
memory; they never perform an exchange. If refresh fails, cache requests return
503 while the child continues. Strict mode fails initial authentication. Default
initial failure starts the command with `TURBO_CACHE=local:rw`, no remote token and
an unreachable loopback API. Explicit Turbo CLI cache flags take precedence over
its environment; avoid forcing remote-only caching when requesting fail-open.

Only the Remote Cache artifact routes are forwarded. Incoming cookies, DPoP,
authorization, forwarding headers and arbitrary headers are discarded. Upstream
redirects are never followed. GET/HEAD retry 502/503/504 and network failures twice
with bounded delays; PUT/POST are never replayed. Each bound outgoing request and safe retry gets a fresh DPoP proof from the job signer. Stats report hits, misses, uploads, failures, retries
on stderr without paths, credentials or upstream error bodies.

`env --format github|gitlab|shell|dotenv|json` emits credentials intentionally.
For GitHub, append github output to `$GITHUB_ENV`; for GitLab, write gitlab output
to a dotenv report. Shell output quotes values; line formats reject control and
interpolation characters. Token TTL is the maximum allowed by the matched policy,
instance ceiling, signer ceiling and remaining CI assertion lifetime. Env mode
cannot refresh Turbo's captured token: use exec for jobs that exceed that TTL.
Do not log env output or commit it. The Action masks values before exporting them.

The proxy command stays in the foreground; callers starting it in a background
process must detach/redirect its standard streams. State files use exclusive create
and mode 0600, contain only the loopback environment, and are removed on normal
shutdown. They contain the session secret: use a private temporary directory.
Stop authenticates over loopback, rather than killing a possibly reused PID. The
Action owns background startup/readiness/post cleanup in STV-450.

## Runner lifecycle evidence and limitations

Local tests start the proxy in one process, use it from a later independent process,
then authenticate a stop and verify state removal. This establishes process-level
behavior on the current macOS host, not hosted-runner certification.
[GitHub runner cleanup](https://github.com/actions/runner/blob/main/src/Runner.Worker/JobExtension.cs)
tracks orphan processes and cleans them during job finalization. The upcoming E2E
workflow exercises hosted Linux/macOS/Windows across steps and post cleanup.
Self-hosted, ephemeral/ARC, container, composite and reusable setups must run the
same probe before relying on cross-step lifetime; exec keeps the proxy and Turbo
in one step and is the portable fallback. Container steps must share the proxy's
network namespace for loopback access. No hosted-runner results are claimed here.

## Throughput

Run `bun packages/cli/bench/proxy.ts`. It streams a 64 MiB download, warms twice and
compares ten direct/proxied medians without materializing the artifact. On the local
host, unpaced loopback measured 14.08 ms direct / 20.40 ms proxy, or 30.98% loss:
the under-5% target is **not met on unpaced loopback**. This measures an additional
socket hop at RAM/network-stack speed. Test representative WAN/storage throughput
before choosing a deployment; do not extrapolate this number to remote Workers.
With `--paced` (250 MiB/s source), the same fixture measured 301.72 ms direct /
298.32 ms proxy, no measurable loss. That fixture meets the 5% target; it does not
erase the unpaced result or establish a production WAN guarantee.

`doctor --server [URL] [--json]` reads validated instance capabilities using
TURBO_API/TURBO_TOKEN. Other doctor checks follow in STV-489.

## Developer commands

```sh
tcache login --api https://cache.example.com
tcache whoami
tcache link --team my-org --project PROJECT_ID
tcache exec -- turbo run build
tcache token --refresh # prints a secret; prefer exec
tcache logout
```

Login prefers the native OS credential manager via `Bun.secrets`; when unavailable,
it warns and uses a 0600 file under a 0700 `~/.config/tcache` directory. Keychain
metadata contains no session token. A keychain lookup failure fails closed. Logout
revokes the session remotely before deleting local credentials, so network failure
leaves it available for a retry. See [device login](../../docs/device-login.md) and
[developer tokens](../../docs/developer-tokens.md).

Link accepts a team ID/slug and project ID, or offers interactive choices. Project
listing requires the organization's list permission; members with only a direct
project grant should pass its ID. The non-secret `.turbo-cache.json` records API,
organization ID/slug, and project ID/slug. Existing files require `--force`.

Admin commands keep authorization on the server. Use `admin projects
list|create|get|update|delete`, `admin keys list|create|revoke`, and `admin policies
list|create|update|delete|test`; pass `--team`, `--project`, `--id` as appropriate and
`--json '<request body>'` for mutations. Key bodies use `organizationId` and the
server's scoped key contract. A key creation response is intentionally secret;
never log it. Project deletion requires the server's confirmation body. Purge
retains its preview/confirm workflow and session-cookie adapter.

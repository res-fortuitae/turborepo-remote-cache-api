# Device login

Run `bun packages/cli/src/bin.ts login --api https://cache.example.com`.
Open the displayed URL, sign in with GitHub, enter the terminal code, and check the
client name and requesting IP. Approve only your own device. Requests expire in
five minutes. The CLI polls at five seconds or slower and backs off on `slow_down`
and rate limits. Denial, expiration, or cancellation requires a fresh request.

The first-party client ID is `tcache`; arbitrary clients, user prebinding, and
custom scopes are rejected. This flow obtains a Better Auth session, not a cache
JWT. Developer cache token issuance is separate. Treat the CLI session as an
account credential: it can exercise the signed-in user's application access.

Sessions prefer the native OS credential store. If unavailable, login warns and
falls back to `~/.config/tcache/session.json` (directory 0700, file 0600).
No session or device secret is printed. Use an OS-encrypted home directory on
shared machines. The CLI rejects symlink session files and insecure file modes.

Device requests, including the requesting IP, live in D1. KV secondary storage is
not involved in code issuance, decisions, polling intervals, or single-use
redemption. Approval verifies a live D1 session and rejects banned users and
impersonation. Decisions and their audit events commit in one D1 batch; a failed
audit write cannot authorize a device. Browser approval retains Better Auth's
origin and CSRF checks. IP and endpoint limits use the Rate Limiting binding.

The approval view is `/device` (`/?view=device` still works for older clients);
it deliberately asks for code confirmation and an explicit decision. The broader
instance console is tracked separately in STV-473.

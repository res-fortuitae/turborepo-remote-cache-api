# GitHub sign-in

The Worker serves passwordless Better Auth endpoints under `/api/auth`. Configure
the GitHub provider by setting both the public `githubApp` identifiers in root
`deploy.config.ts` and `GITHUB_OAUTH_CLIENT_SECRET` in the root environment or
deployment secret store. A missing/empty half of the pair fails planning. With
neither configured, the provider stays disabled. No credentials belong in config.

For a GitHub App, allow user authorization and give **Email addresses: Read-only**
account permission. Use the Client ID and client secret, not an installation token.
Register the callback `https://<canonical-domain>/api/auth/callback/github` for
the corresponding stage. Better Auth requests `read:user` and `user:email` and
fetches the email list to handle private email addresses. See the
[Better Auth GitHub guide](https://better-auth.com/docs/authentication/github).

Start a browser sign-in with Better Auth's `signIn.social({ provider: "github",
callbackURL: "/" })`, or POST JSON to `/api/auth/sign-in/social` with those fields
and follow the returned authorization URL. The dashboard sign-in UI is STV-466.
OAuth state binds the callback to the initiating browser. Better Auth receives the
canonical origin for its base URL and trusted origins. CSRF/origin checks are
explicitly enabled, including under test. HTTPS cookies are Secure and HttpOnly
with SameSite=Lax; HTTP localhost development keeps non-Secure cookies. Password
registration and password sign-in are disabled.

## Stored identity

`account.providerId = "github"` and `account.accountId` store GitHub's immutable
numeric user ID as a string. The nullable `account.githubLogin` column stores the
current login name and refreshes on returning OAuth sign-in. Use the immutable ID
for identity matching; logins can change and can be reused by another user.

GitHub login metadata is server-owned (`input: false`) and comes from the verified
provider profile. Better Auth exposes it to `validateUserInfo`; request-context
weak keys carry it to account create/update hooks, which write it alongside the
account mutation. No additional GitHub request or module-level profile cache is
needed. Concurrent callback tests verify that profiles stay bound to their own
accounts. This does not implement the audit intent/reconciliation work in STV-458.

The additive migration adds one nullable `github_login` column. Existing users,
sessions and accounts survive the upgrade. Older account rows populate the login
on their next GitHub OAuth sign-in. The committed migration is applied by Alchemy
during an authorized deployment; no live migration is needed for the unit tests.

## Local OAuth checks with emulate.dev

```sh
bun install --frozen-lockfile
bun test packages/auth/src/github.test.ts
```

The integration suite starts [emulate.dev](https://emulate.dev/docs/programmatic-api)
on an ephemeral loopback port, seeds users and registers a GitHub OAuth app with
test-only credentials and the exact callback URL. It visits the emulator's real
authorization chooser, submits a seeded user, follows the callback into the real
Better Auth handler, exchanges the code, reads profile/email data, then checks
D1-compatible account/session storage and secure cookies.

Only the test fetch transport redirects `github.com` and `api.github.com` to the
local emulator. Production provider endpoints remain unchanged. Unexpected
outbound hosts fail the test; no live GitHub or Cloudflare credentials are needed.
The emulator and transport are closed/restored after the suite. Tests also cover
returning sign-in, concurrent users, tampered state and untrusted origins/redirects.

## Optional email sign-in

`AuthSettings.magicLink: true` opts a library consumer into Better Auth's magic-link
plugin. Compose `AuthLive` with a delivering `Mailer` layer. Links expire in ten
minutes, verification tokens are hashed in D1, and a successful verification
consumes the token. The auth test suite checks delivery, session creation and replay
rejection. Password sign-in stays disabled.

The stock Worker supplies `MailerNoop` and leaves magic links disabled. Do not
enable them with a mailer that drops messages. STV-495 owns Cloudflare Email Service
delivery and its deployment configuration; there is currently no magic-link switch
in `deploy.config.ts`. This avoids offering nonfunctional email login in deployed
instances while providing the optional auth integration for a delivering layer.

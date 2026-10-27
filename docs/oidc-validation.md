# OIDC verification — 27 October 2026

Local OIDC application verification passed. This covers real cryptography,
policy matching, exchange, DPoP-bound cache access, actual CLI/Action/Turbo clients,
refresh and audit persistence. It does **not** certify a real GitHub/Vercel-issued
CI assertion or a deployed preview. Application infrastructure remained local.

## Verification layers

| Layer                           | Evidence                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC/security suites            | 71 tests passed across verifier, JWKS cache, policy guardrails/matcher, DPoP, exchange HTTP and Action/Turbo E2E                                                        |
| Client/provider/runner suites   | 36 tests passed across client-core, CLI CI-provider adapters and the runner-probe fixture                                                                               |
| Extended durable E2E regression | Actual CLI bound writer uploads with Turbo; CLI read-only identity restores; outside/expired identities fail strict authentication before executing the wrapped command |
| Actual local root stack         | 48 checks passed against the real Alchemy Worker, D1, R2, KV, Coordinator, Secrets Store and rate limits                                                                |
| Live issuer metadata            | GitHub and Vercel discovery/JWKS endpoints returned HTTP 200 and public RS256 keys                                                                                      |

The existing Action/Turbo E2E uses GitHub-shaped assertions signed with a fixture
RSA key, simulated GitHub discovery/JWKS HTTP and in-memory artifact storage.
SQLite, verifier, policy, signer, replay, proof verification and HTTP routing are
real. The added CLI paths use the same real security services; no browser session
or static API key participates. This is durable automated regression coverage,
not proof that GitHub issued the test assertion.

The separate root-stack probe used a disposable local stage and the supported
custom-issuer configuration with a temporary public RSA pin for
`https://oidc-validation.example.com/ci`. Its private key existed only in the
probe process. The issuer name did not serve a network service: pinned custom
issuers intentionally do not use discovery. Assertions were locally signed test
data. No issuer-verifier, HTTP, storage, Coordinator or rate-limit implementation
was replaced in that probe.

Only initial organization, project, policy, instance-allowlist and developer
session/membership/grant fixtures were inserted into the empty stage's migrated
local database. This does not test real user registration. The application then
verified every exchange and cache request normally. Policies required exact
subject, audience and branch and required DPoP binding. Legacy shared-token access
was disabled. A generated application Ed25519 key was supplied to the test process;
existing root secrets were not overwritten.

The root deploy config temporarily contained the public test pin, and was restored
**byte-for-byte** in cleanup. Test policies, organizations, developer identity and session were removed, the
local process group stopped, and private temporary token files/drivers removed.
No Cloudflare deployment, dependency patch or dependency-source edit occurred.
The passing root-stack run needed no startup retry.

## Actual root-stack checks

- Valid bound exchange returns no-store credentials. The returned cache JWT's
  Ed25519 signature was independently verified against the generated application
  public key before checking issuer, audience, organization, project, scope, TTL
  and confirmation-key binding.
- Bound writer PUT stores an artifact in real local R2; a bound GET restores its
  exact bytes. A read-policy exchange grants only read; PUT is refused.
- Reusing a DPoP proof is rejected. Missing proof, wrong proof key, method, URL or
  access-token hash are rejected. A bound JWT cannot downgrade to Bearer.
- Reusing a CI assertion is rejected. Two concurrent exchanges for one fresh
  assertion produce exactly one 200 and one 403 through the D1 replay guard.
- Wrong audience, expired signature-valid assertion, future not-before,
  unregistered issuer, unknown signing-key ID, tampered JWT payload, outside
  subject, wrong branch and foreign project are rejected.
- An exchange without a proof cannot bypass a binding-required policy.
- The compiled macOS ARM64 CLI obtains a bound writer credential through OIDC and
  produces an actual Turbo remote upload. A new read-only OIDC identity restores
  a remote Turbo hit after deleting `dist` and `.turbo`, with zero uploads and
  exact restored bytes. No login session or API-key fallback is available.
- CLI `env --strict` cannot export an unbound credential under that policy.
- A separately signed-in developer reader restores the same OIDC-uploaded Turbo
  cache with identical output and zero uploads. This verifies that CI OIDC and
  developer credentials share the authorized project's namespace. A developer
  session without a CI assertion cannot authorize `/oidc/exchange`.
- A five-second cache JWT is refreshed in the actual CLI proxy while a private
  projected token file supplies fresh signed CI assertions. Cache access still
  succeeds after 7.5 seconds, beyond the initial JWT lifetime. Static assertion
  reuse is not treated as a valid refresh strategy.
- D1 persists 22 OIDC exchange audit events, including allow and deny. Known raw
  assertions, returned cache JWTs and an unknown secret-bearing claim are absent.
  Successful R2 uploads persist credential-attributed provenance.

The 48 assertions include readiness, response headers, output redaction and
restored-byte checks; they are not 44 independent deployment environments.
[Sanitized root results](validation/oidc-local-2026-10-27.json) contain only labels,
pass states, stage identifier, counts and scope—not credentials or private keys.

## Live issuer boundary

Read-only requests checked the real public endpoints:

- GitHub: `https://token.actions.githubusercontent.com/.well-known/openid-configuration`
  and its advertised JWKS, both HTTP 200, four public RS256 keys at check time.
- Vercel: `https://oidc.vercel.com/.well-known/openid-configuration` and its
  advertised JWKS, both HTTP 200, two public RS256 keys at check time.

These are point-in-time availability/key-shape checks, not authentication with
an actual CI token. [Sanitized discovery results](validation/oidc-discovery-2026-10-27.json)
record that scope. The existing verifier suites separately test key rotation,
refresh coalescing, unknown-key cooldown, corrupt KV, private/symmetric key
rejection, unsafe discovery/redirects, and provider-specific immutable identities.

A real GitHub-issued assertion requires an Actions job with `id-token: write`
and the runner's OIDC request credentials; a developer `gh` login is not a CI
assertion. See GitHub's [OIDC documentation](https://docs.github.com/en/actions/concepts/security/openid-connect)
and [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
Hosted jobs for this repository are billing-blocked, and the repository has no
registered self-hosted runner. No runner was registered as part of these local
application tests. Real-provider assertions, hosted runner lifecycle, cloud
geography and deployed preview SLOs remain unverified. The existing
[acceptance workflow guide](oidc-e2e.md) describes those separate gates.

STV-508 and the M9 epic remain In Progress for their outstanding performance
requirements; passing OIDC checks does not change that status.

Model: gpt-6.1-sol; agent: Codex (/root); harness: T3 Code / Codex.

Recorded at 2026-10-27T12:50:36.123Z.

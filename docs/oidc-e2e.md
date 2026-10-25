# OIDC acceptance and runner probes

M4 acceptance has two independent layers: deterministic local security coverage,
and workflows against the actual runner/optional existing preview. These workflows
never provision or destroy infrastructure. STV-431 preview provisioning was canceled.

## Local security round trip

```sh
bun test apps/server/tests/oidc-e2e.test.ts
bun test scripts/oidc-runner-probe.test.ts
```

The security suite signs GitHub-shaped assertions with a fixture RSA key, verifies
through the real OIDC verifier/discovery contract, matches saved policies in real
SQLite, exchanges into real signed/epoch cache JWTs, launches the committed Node 24
Action daemon, and runs the actual Turbo binary over HTTP. Only GitHub discovery/
JWKS and artifact storage use local adapters. No remote credentials are needed.

It proves all four cases:

- A main/push identity writes artifacts through the DPoP-bound proxy.
- A PR identity restores a real remote Turbo cache hit after local output/cache
  deletion, but its PUT receives 403.
- A signed assertion from a repository outside the saved immutable-ID policy is
  rejected; durable audit records policy mismatch.
- An expired, correctly signed CI assertion is rejected; durable audit records
  expiry rather than a different denial.

The runner probe launches a short-lived-token fixture in a detached process,
starts the shipped Action in another process, then runs a later independent step
after the initial credential expires. It checks refresh, complete GET and streamed
PUT, runs cache post, and verifies the listener actually closed. This validates
the workflow probe itself locally; it does not certify a hosted runner.

## Runner lifecycle workflow

`.github/workflows/validate.yml` calls the reusable
`oidc-runner-lifecycle.yml`. Its matrix covers hosted Linux/macOS/Windows with both
direct and composite use of the JavaScript Action. A separate container job uses
the same composite path. Steps run the fixture, register a cleanup verifier,
start the Action, and access it from a later runner step. Post actions run in
reverse order, so the verifier checks closure after the cache Action's automatic
post. The fixture is then stopped without leaving tokens/processes behind.

The fixture intentionally accepts test assertions; it tests runner process/network
lifetime, not issuer trust. The local security suite above tests real signatures,
policy denial and DPoP verification. No production trust policy is loosened.

Dispatch `oidc-runner-lifecycle.yml` with `self_hosted_labels` set to a JSON array to
run the same probe on existing self-hosted/ephemeral/ARC runners, for example
`["self-hosted","linux","arc"]`. The workflow creates no runner infrastructure.
Self-hosted jobs are not scheduled automatically from PRs. All steps must share a
network namespace for loopback access. If a runner cannot retain the daemon across
steps, use `tcache exec -- turbo run build` inside one step; env mode is an unbound
fallback when policy permits it. General doctor diagnostics remain STV-489.

## Existing preview and real GitHub identities

Create/configure a dedicated preview project through the normal operator process.
Use exact repository/owner IDs, the preview origin as audience, a bound write policy
limited to pushes on main, and a bound read policy for pull requests. Follow
[OIDC guardrails](../packages/oidc/README.md). This PR does not deploy a preview or
change those policies. Do not test permission denials against a production project.

`oidc-preview.yml` is reusable from a test repository and manually dispatchable. It
checks out this implementation at the supplied reviewed full `implementation_ref`
commit SHA, while GitHub ID tokens describe the calling repository/event. Inputs
are the existing HTTPS `api`, organization `team`, `project`, and `expectation`:

- `write`: invoke from main's push workflow to force a real Turbo upload and seed
  a fixed HTTP artifact. Use this first to prime the dedicated preview.
- `read`: invoke from the same repository's PR workflow. Require a real Turbo hit
  and restored output, verify the fixed artifact, and require PUT to return 403.
- `denied`: invoke FROM a second repository outside the saved policy. It mints a
  real GitHub identity for the preview audience and submits it with a valid DPoP
  exchange proof, requiring 403. It must not be run from an allowed repository as
  a substitute for the outside-repository case.

Enable `expiry_probe` on an allowed caller to mint a fresh GitHub assertion, keep
it unexchanged in memory until 61 seconds past its `exp`, then require exchange to
return 403 using a fresh valid proof. It does not replay an already consumed jti
or forge/modify a real GitHub token. The unverified payload decode only determines
a bounded wait, never grants access. The job may take up to 21 minutes; its timeout
is 30 minutes. Match that grace to the preview's configured clock skew if it exceeds
60 seconds. Local tests cover expiry without waiting for real GitHub token expiry.

A caller workflow uses a reviewed full SHA in both places (replace placeholders):

```yaml
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
  id-token: write
jobs:
  preview:
    uses: StvyaSharma/turborepo-remote-cache-api/.github/workflows/oidc-preview.yml@<reviewed-full-commit-sha>
    with:
      api: https://preview-cache.example.com
      team: preview_org_id
      project: preview_project_id
      implementation_ref: <same-reviewed-full-commit-sha>
      expectation: ${{ github.event_name == 'push' && 'write' || 'read' }}
      expiry_probe: false
```

Use a separate caller with `expectation: denied` for the outside repository case.
Manual dispatch produces a `workflow_dispatch` event, so a write test requires an
explicit safe policy for that event on main; a push-only policy should deny it.
Fork PR permissions may prevent minting an identity; do not broaden write access
to make that test pass. Use an allowed same-repository PR for the read-hit case.

Own-repository CI dogfoods the Action before check/test when non-secret repository
variables `TCACHE_API`, `TCACHE_TEAM`, `TCACHE_PROJECT` are set. Missing variables
skip remote authentication and preserve normal local validation. Default Action
fail-open behavior lets CI run if identity/policy/service access is unavailable.
No cache key or deployment secret is required. Configuring variables/policies and
running an actual preview or hosted workflow remain operator/CI validation steps.

At implementation time no cache variables were configured and no preview was
provisioned or workflow manually dispatched. Passing local suites and actionlint
are the evidence available; hosted/container/self-hosted/real-preview results must
be recorded from their workflow runs after review. Nothing here claims otherwise.

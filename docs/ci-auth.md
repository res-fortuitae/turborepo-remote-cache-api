# CI authentication with tcache

Prefer `tcache exec -- turbo run build`: it keeps a loopback proxy alive and
refreshes credentials. `tcache ci-auth --format shell|gitlab|dotenv|json|github`
is an explicit export alternative. It returns nonzero and emits no environment
when authentication fails. It never falls back to a developer session.

Set `TCACHE_API`, `TCACHE_TEAM` (organization ID), and `TCACHE_PROJECT` (project ID),
or pass `--api`, `--team`, and `--project`. The configured audience defaults to the
cache origin. Each issuer and exact project/repository identity must be enabled in
an administrator-created trust policy. Untrusted PRs should receive read access.
Do not use shell tracing around authentication or print exported credentials.

The examples assume a pinned, verified `tcache` binary is already on PATH (see the
[distribution guide](cli-distribution.md)). A container invocation can mount the
workspace and binary image, but the wrapped build tools must also exist in that
container; the minimal CLI image alone does not include Node or Turbo.

## GitLab

```yaml
cache-build:
  image: node:24
  id_tokens:
    CACHE_ID_TOKEN:
      aud: https://cache.example.com
  variables:
    TCACHE_API: https://cache.example.com
    TCACHE_TEAM: org-id
    TCACHE_PROJECT: project-id
  script:
    - tcache exec -- npx turbo run build
```

For a downstream dotenv report, use `umask 077; tcache ci-auth --format gitlab >
cache.env` and configure `artifacts:reports:dotenv: cache.env`. Restrict artifact
access and retention; the file contains a short-lived credential and cannot
refresh it. [GitLab ID-token documentation](https://docs.gitlab.com/ci/secrets/id_token_authentication/).

## CircleCI

```yaml
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/node:24.0
    environment:
      TCACHE_API: https://cache.example.com
      TCACHE_TEAM: org-id
      TCACHE_PROJECT: project-id
    steps:
      - checkout
      - run: tcache exec -- npx turbo run build
workflows:
  build:
    jobs: [build]
```

Install the CircleCI **environment CLI** as well as tcache. `CIRCLECI` or
`CIRCLE_OIDC_TOKEN_V2` detects the provider, but client-core obtains a fresh V2
token with `circleci run oidc get --claims '{"aud":"<cache origin>"}' --v2`.
The environment token's default audience is not reused. This preserves the server's
cache-audience requirement and one-time assertion replay rules. See
[CircleCI custom audience tokens](https://circleci.com/docs/guides/permissions-authentication/oidc-tokens-with-custom-claims/).

## Buildkite

```yaml
steps:
  - label: Build with cache
    env:
      TCACHE_API: https://cache.example.com
      TCACHE_TEAM: org-id
      TCACHE_PROJECT: project-id
    command: tcache exec -- npx turbo run build
```

Keep `buildkite-agent` available on PATH. Client-core invokes `buildkite-agent oidc
request-token --audience <cache origin>` without a shell for each refresh. See
[Buildkite OIDC CLI](https://buildkite.com/docs/agent/cli/reference/oidc).

## Bitbucket

```yaml
image: node:24
pipelines:
  default:
    - step:
        oidc: true
        script:
          - export TCACHE_API=https://cache.example.com
          - export TCACHE_TEAM=org-id TCACHE_PROJECT=project-id
          - tcache exec -- npx turbo run build
```

`BITBUCKET_STEP_OIDC_TOKEN` is provided by the opted-in step. Configure the workspace
issuer and audience in the instance's supported issuer configuration and exact
repository UUID claims in the policy. An immutable environment assertion cannot
be renewed beyond its provider lifetime; split longer jobs. See
[Bitbucket step OIDC option](https://support.atlassian.com/bitbucket-cloud/docs/step-options/).

## No OIDC

Store a scoped API key as the CI secret `TCACHE_API_KEY`. With no detected issuer,
`tcache exec` and `ci-auth` use it under the instance's API-key policy. Prefer
read-only keys and restrict write keys to protected workflows. A broken detected
OIDC provider never silently downgrades to the API key. The key is a bearer secret;
rotate it and use an ephemeral runner. No device login is needed in CI.

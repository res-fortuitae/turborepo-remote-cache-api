# Local CLI binaries and release candidates

Publication is disabled. No npm name or registry account is needed for local tests.
Use Bun 1.4.3 from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/cli build
packages/cli/dist/tcache-darwin-arm64 --help # choose your host's filename
packages/cli/dist/tcache-darwin-arm64 login --api https://cache.example.com
packages/cli/dist/tcache-darwin-arm64 link --team ORG --project PROJECT_ID
packages/cli/dist/tcache-darwin-arm64 exec -- turbo run build
bun run --cwd packages/cli bench:startup
```

`build` defaults to the host. `build linux-x64` chooses one target; `build:all`
compiles Linux x64/arm64 glibc and musl, macOS x64/arm64, and Windows x64.
Bun downloads the pinned target runtime during cross-compilation. No Node/Bun
installation or install hook is needed to execute a binary. Linux builds use the
host runtime libraries; Alpine/musl hosts need `libstdc++` (`apk add libstdc++`). x64 Linux/Windows
builds use baseline CPU targets. Default dotenv/bunfig/tsconfig/package autoloading
is disabled in compiled executables. Explicit environment and repo link config
remain supported. See [Bun executable documentation](https://bun.com/docs/bundler/executables).

Each build writes SHA256SUMS, bundled dependency license texts, and the Bun runtime
license/provenance notice. `LICENSE.bun` is copied unchanged from
[oven-sh/bun at bun-v1.4.3](https://github.com/oven-sh/bun/blob/bun-v1.4.3/LICENSE.md).
Bun's notice identifies its linked libraries and the WebKit rebuild procedure.
The repository has no root distribution license; npm candidate metadata therefore
uses `UNLICENSED` rather than inventing a license. Decide source distribution
licensing before public publication, and retain all dependency/runtime notices.

Budgets: at most 128 MiB per executable; at most 500 ms p95 across twenty `--version`
process starts on the validation runner. The macOS arm64 local candidate measured
about 68 MiB and 34 ms p95. These are CLI startup/size budgets, not cache throughput
claims. `TCACHE_TEST_BINARY=/absolute/path/to/tcache bun test packages/cli/src/cli.test.ts
packages/cli/src/auth.test.ts` exercises the compiled CLI with fixture servers.

## Containers

```sh
bun run --cwd packages/cli build linux-arm64
docker build --build-arg TCACHE_ARCH=arm64 \
  -f packages/cli/distribution/Dockerfile -t tcache-local packages/cli
docker run --rm tcache-local --version
```

Use `TCACHE_ARCH=x64` with a matching Linux x64 Docker platform. The pinned
distroless nonroot image includes only the compiled CLI, runtime libraries and
notices. No Node/Turbo/shell is present: mount/provide compatible build tools if
using `exec`, or run the binary in your existing runner image. Native credential
stores may be unavailable in containers; private-file fallback is documented.
No image is pushed to GHCR by the current workflow. A future release may publish
`ghcr.io/stvyasharma/tcache` after review and explicit publication authorization.

## Candidate automation and future publication

`.github/workflows/cli-binaries.yml` builds the seven targets and exercises native
Linux/macOS/Windows smoke/budget checks plus Linux musl and a distroless container.
It uploads **test artifacts only**. The signing job is off unless an operator
explicitly sets `TCACHE_RELEASE_SIGNING_ENABLED=true`, configures the protected
`cli-release` environment, and manually dispatches on a `cli-v*` tag. Protect that
environment with reviewers/tag restrictions and protect tag creation before
turning signing on. No job publishes GitHub Releases, npm packages or GHCR images.

The optional signing job uses GitHub OIDC, GitHub build-provenance attestations,
and a Sigstore bundle for SHA256SUMS. Never create a release from a PR artifact.
For a future reviewed release, verify candidates using:

```sh
gh attestation verify ./tcache-linux-x64 \
  --repo StvyaSharma/turborepo-remote-cache-api \
  --signer-workflow StvyaSharma/turborepo-remote-cache-api/.github/workflows/cli-binaries.yml
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity 'https://github.com/StvyaSharma/turborepo-remote-cache-api/.github/workflows/cli-binaries.yml@refs/tags/cli-v0.1.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum --check SHA256SUMS
```

See [GitHub attestation verification](https://cli.github.com/manual/gh_attestation_verify).
A future version-pinned installer is supplied at `distribution/install.sh`; it
downloads the selected binary and checksum manifest from the same `cli-vX.Y.Z`
release, verifies SHA-256, and only then installs it. It never executes downloaded
bytes. No release URL exists until an actual release is published. Pin the script
URL/version; inspect it before running. Verify attestation/signature separately
when stronger provenance assurance is needed.

`bun packages/cli/scripts/homebrew.ts` generates `dist/tcache.rb` with exact hashes
from a complete seven-target manifest. It is ready for a future Homebrew tap's
`Formula/tcache.rb`; no tap is created or updated automatically.

npm's unscoped `tcache` is unrelated. Once naming and publication are approved,
`TCACHE_NPM_SCOPE=@your-scope bun run --cwd packages/cli package:release` creates
one candidate package per platform plus a Node 22+ launcher with optional native
dependencies. They have **no install-time scripts**. Packaging does not publish.
Before publishing, reserve the scope/packages and configure
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for every
package, the reviewed workflow and protected environment. Use OIDC-only publication
and provenance, not an npm token. Publication automation remains intentionally
deferred until all M5 features and platform validations are accepted.

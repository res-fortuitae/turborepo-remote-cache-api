# tcache

`tcache` is the MIT-licensed CLI for a self-hosted Turborepo remote cache.
Res Fortuitae publishes [`@resfortuitae/tcache`](https://www.npmjs.com/package/@resfortuitae/tcache/v/0.1.1)
and its `@resfortuitae/tcache-<target>` platform packages.

## Install

```sh
npm i -g @resfortuitae/tcache
tcache --version
tcache --help
```

npm installs one native binary for your platform through optional dependencies,
so keep optional dependencies enabled. Node 22 or later runs the launcher.
Supported targets: Linux x64/arm64 (glibc and musl), macOS x64/arm64 and Windows x64.

In CI, pin the version with `npm i -g @resfortuitae/tcache@0.1.1`. Configure
[CI authentication](https://github.com/res-fortuitae/turborepo-remote-cache-api/blob/main/docs/ci-auth.md),
then run `tcache exec --strict -- turbo run build`.
Upgrade with `npm i -g @resfortuitae/tcache@latest`. Uninstall with
`npm rm -g @resfortuitae/tcache`.

Without npm, download a binary and `SHA256SUMS` from a
versioned [GitHub Release](https://github.com/res-fortuitae/turborepo-remote-cache-api/releases/tag/cli-v0.1.1),
or download the release's `install.sh` and run `sh install.sh v0.1.1` on Linux
or macOS. The installer checks the binary against the release's SHA-256 manifest
before placing it in `~/.local/bin`.

## First use

From your Turborepo checkout, sign in to your instance and approve the device
login in your browser. Link the checkout using your organization slug and the
project's ID from the instance. The link writes a credential-free
`.turbo-cache.json`.

```sh
tcache login --api https://cache.example.com
tcache link --team ORG --project PROJECT_ID
tcache exec --strict --write -- turbo run build
```

`--write` explicitly requests a developer write token. Your project grant must
allow writes, and the instance's effective `developerCacheWrites` policy must
enable them. `--strict` stops before running the build if the initial credential
request fails. Omit `--write` for the default read-only developer token.

### Sharing cache entries with CI

Turborepo computes task hashes from your repository's inputs. Pin the build
toolchain and match runtime versions between developer machines and CI. Put
runtime versions and other output-affecting environment values in Turbo's
hashed inputs so changing them produces a different key.

For tasks that produce platform-specific outputs, include the target OS and
architecture in the task hash, plus libc or other ABI differences where
applicable. Portable tasks can share entries across platforms when their
outputs are identical for the same inputs. The CLI's own binary target only
determines where the CLI can run. See [Turborepo's caching guide](https://turborepo.dev/docs/crafting-your-repository/caching).

## Verify a release

npm packages carry npm provenance. For direct downloads, verify the binary's
GitHub build attestation and the signature on `SHA256SUMS`. This example checks
the Linux x64 binary for `cli-v0.1.1`. Substitute your downloaded asset name
in both commands that use it.

```sh
gh attestation verify ./tcache-linux-x64 \
  --repo res-fortuitae/turborepo-remote-cache-api \
  --signer-workflow res-fortuitae/turborepo-remote-cache-api/.github/workflows/cli-release.yml
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity 'https://github.com/res-fortuitae/turborepo-remote-cache-api/.github/workflows/cli-release.yml@refs/tags/cli-v0.1.1' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
awk '$2 == "tcache-linux-x64"' SHA256SUMS | shasum -a 256 --check
```

## Build from source

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
Packages also include the repository's MIT `LICENSE`.

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
`ghcr.io/res-fortuitae/tcache` after review and explicit publication authorization.

## Releasing

The version lives in `packages/cli/package.json`. To release:

1. Bump `version` there and merge to `main`.
2. Push a matching tag: `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z`.
3. Approve the run in the `cli-release` environment.

`.github/workflows/cli-release.yml` rejects a tag that does not match the
version. It reuses the build and smoke jobs from `cli-binaries.yml`, then on a
GitHub-hosted runner: verifies checksums, attests the binaries, signs
`SHA256SUMS`, publishes the 7 platform packages and then `@resfortuitae/tcache`
to npm through trusted publishing (no npm token), and uploads the binaries,
`SHA256SUMS`, its Sigstore bundle, `install.sh` and the Homebrew formula to a
GitHub Release. Versions already on npm are skipped, so a failed run can be re-run.

One-time setup: protect `cli-v*` tag creation with a ruleset, create the
`cli-release` environment with a required reviewer, and add a trusted publisher
(this repository, `cli-release.yml`, environment `cli-release`) to each of the
8 npm packages. Packages have no install-time scripts.

`bun packages/cli/scripts/homebrew.ts` generates `dist/tcache.rb` for a future
Homebrew tap; no tap is created or updated automatically. No container image is
published.

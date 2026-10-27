#!/bin/sh
set -eu
version=${1:?Usage: install.sh vMAJOR.MINOR.PATCH}
case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo 'Pass a pinned version (vMAJOR.MINOR.PATCH).' >&2; exit 1;; esac
if ! printf '%s' "$version" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then exit 1; fi
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo 'Use the Windows release executable.' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported CPU.' >&2; exit 1;; esac
libc=
if [ "$os" = linux ] && ldd /bin/sh 2>&1 | grep -qi musl; then libc=-musl; fi
asset=tcache-$os-$arch$libc
base=https://github.com/StvyaSharma/turborepo-remote-cache-api/releases/download/cli-$version
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base/$asset" -o "$scratch/$asset"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$scratch/SHA256SUMS"
awk -v name="$asset" '$2 == name && length($1) == 64 {print $1 "  " name; count++} END {if (count != 1) exit 1}' "$scratch/SHA256SUMS" > "$scratch/selected.sha256"
(cd "$scratch"; if command -v sha256sum >/dev/null 2>&1; then sha256sum -c selected.sha256; else shasum -a 256 -c selected.sha256; fi)
# Only the verified file reaches the destination. It is never executed by this installer.
destination=${TCACHE_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$destination"
install -m 755 "$scratch/$asset" "$destination/tcache"
printf 'Installed %s to %s/tcache\n' "$version" "$destination"

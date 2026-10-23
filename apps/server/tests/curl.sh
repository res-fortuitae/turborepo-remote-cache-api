#!/usr/bin/env bash
set -euo pipefail

: "${TURBO_API:?Set TURBO_API to the running Worker URL}"
: "${TURBO_TOKEN:?Set TURBO_TOKEN to the Worker bearer token}"
base="${TURBO_API%/}/v8/artifacts"
team="curl-$(date +%s)-$$"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

expect_status() {
  local expected="$1"
  shift
  local actual
  actual="$(curl --silent --show-error --max-time 30 -o "$tmp/body" -w '%{http_code}' "$@")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Expected HTTP %s, got %s\n' "$expected" "$actual" >&2
    cat "$tmp/body" >&2
    exit 1
  fi
}

auth=(-H "Authorization: Bearer $TURBO_TOKEN")
expect_status 401 "$base/status"
expect_status 403 -H 'Authorization: Bearer invalid' "$base/status"
expect_status 200 "${auth[@]}" "$base/status"
[[ "$(cat "$tmp/body")" == '{"status":"enabled"}' ]]
expect_status 404 "${auth[@]}" "$base/deadbeef?teamId=$team"
expect_status 400 "${auth[@]}" "$base/not-a-hash?teamId=$team"
expect_status 400 "${auth[@]}" "$base/status?teamId=invalid%2Fteam"
expect_status 405 "${auth[@]}" -X DELETE "$base/deadbeef?teamId=$team"

printf 'cache migration artifact\n' > "$tmp/artifact"
expect_status 202 "${auth[@]}" -X PUT --data-binary "@$tmp/artifact" \
  -H 'x-artifact-duration: 42' -H 'x-artifact-tag: migration' "$base/deadbeef?teamId=$team"
headers="$(curl --silent --show-error --max-time 30 --head "${auth[@]}" "$base/deadbeef?teamId=$team")"
printf '%s' "$headers" | tr -d '\r' | grep -qi '^HTTP/1.1 200'
printf '%s' "$headers" | tr -d '\r' | grep -qi '^x-artifact-duration: 42$'
printf '%s' "$headers" | tr -d '\r' | grep -qi '^x-artifact-tag: migration$'
expect_status 200 "${auth[@]}" "$base/deadbeef?teamId=$team"
cmp "$tmp/artifact" "$tmp/body"
expect_status 404 "${auth[@]}" "$base/deadbeef?teamId=$team-other"
expect_status 200 "${auth[@]}" "$base/deadbeef?slug=$team"
cmp "$tmp/artifact" "$tmp/body"
expect_status 200 "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"hashes":["deadbeef","cafe"]}' "$base?teamId=$team"
grep -q '"taskDurationMs":42' "$tmp/body"
grep -q '"cafe":null' "$tmp/body"
expect_status 400 "${auth[@]}" -H 'Content-Type: application/json' -d '{}' "$base?teamId=$team"
expect_status 200 "${auth[@]}" -H 'Content-Type: application/json' \
  -d '[{"sessionId":"migration","source":"REMOTE","event":"HIT","hash":"deadbeef"}]' "$base/events?teamId=$team"
expect_status 400 "${auth[@]}" -H 'Content-Type: application/json' -d '{}' "$base/events?teamId=$team"
printf 'HTTP contract suite passed\n'

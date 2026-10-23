---
status: accepted
---

# Cache JWT signing: jose with our own key set, not better-auth's `jwt` plugin

Cache tokens are short-lived EdDSA (Ed25519) JWTs signed and verified by
`@repo/credentials` with [`jose`](https://github.com/panva/jose). Keys come from a
Secrets Store secret through `KeyStore`. This implements
[STV-442](https://linear.app/stvyas-workspace/issue/STV-442).

## Why not better-auth's `jwt` plugin

The plugin supports EdDSA, publishes a JWKS and rotates keys, but:

- It stores key pairs in a D1 `jwks` table, encrypted with the auth secret. The
  issue requires keys in Secrets Store; D1 would add a read to every verification
  and couple cache-token keys to the auth secret.
- Its tokens are minted from a better-auth session. Cache tokens are also minted
  by OIDC exchange with no session, and need our own claims (`org`, `prj`, `scope`,
  `epoch`) and TTL rules.
- Verification would run through the auth instance, which `@repo/credentials`
  should not need on the hot cache path.

jose is what the plugin uses internally anyway. It runs on WebCrypto in Workers and
Bun, has no dependencies, and gives us the few primitives we need.

## Format

- Header: `alg: EdDSA`, `typ: JWT`, `kid`.
- Claims: `iss` (our URL), `aud: turbo-cache`, `sub`, `org`, `prj`,
  `scope` (`read` | `read write`), `epoch`, `iat`, `nbf`, `exp`, `jti`.
- `epoch` is `{ org, prj }`: the Coordinator's revocation epoch for `org:<id>` and
  `project:<id>` at issue time. The two scopes have independent counters, so a single
  number can't detect a bump in both. Verification rejects the token if either scope
  `isRevoked`.
- TTL is `min(1 h, instance maxTtlSeconds, trust policy maxTtlSeconds)`.

## Keys and rotation

The secret is `{ current: kid, keys: [private Ed25519 JWK, ...] }` with one or two
keys. To rotate: add the new key, switch `current` to it, and remove the old key once
the longest token lifetime has passed. All keys in the set verify and appear in the
JWKS; only `current` signs. Secrets are read per call, so rotation needs no redeploy.

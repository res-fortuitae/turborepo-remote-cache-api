# Artifact signatures

Project admins generate keys and enable upload enforcement under Project settings.
A key is 32 random bytes, exported as a 44-character base64 HMAC secret. D1 stores
only an AES-256-GCM envelope: a fresh random data key encrypts the HMAC secret,
and a separate HKDF-derived wrapping key encrypts the data key. The root wrapping
material is the existing Better Auth secret read from Secrets Store. HKDF domain
separation isolates this use from authentication and multipart tickets. AAD binds
both encrypted payloads to organization, project and key ID. Preserve the wrapping
secret with D1 backups; changing it requires rewrapping existing envelopes first.

Successful, authorized OIDC exchanges and developer-token requests deliver the
current key and, during rotation, one previous key. Access and rotation are audited
without key material. Clients mask every returned key. The CLI/Action already
export `TURBO_REMOTE_CACHE_SIGNATURE_KEY`; repositories must also set
`remoteCache: { signature: true }` in `turbo.json` to make Turbo verify downloads.
API-key and legacy clients must manage their signing secret themselves.

`GET /projects/:id/signing` returns metadata only. `POST` with `{ required: true }`
requires a generated key; `POST /projects/:id/signing/rotate` generates/rotates it.
Management requires a live authorized session, matching Origin, and administrator
passkey proof when enforced. Rotation retains the prior key for 24 hours. Another
rotation is blocked during that overlap, including concurrent requests. Expired
envelopes remain encrypted for recovery but are not delivered. Durable project
deletion removes key/settings rows.

A running Turbo process accepts one environment key. The client keeps that key
stable during credential refresh while it is still in the server's active ring.
After the overlap, the client disables caching and asks the job to restart.
During overlap, the default proxy verifies signatures with the active ring and
translates a valid old-key tag to the process's pinned key. It supports the legacy
JSON HMAC format and Turbo 2.11.10's length-prefixed v2 format. Only this overlap
path spools to a private temporary file (2 GiB maximum), computes HMACs in bounded
chunks, and removes the file on completion/cancellation. Tampering yields 502;
no unverified body is returned. Normal single-key downloads stream directly to
Turbo for verification. Env mode cannot translate tags and treats different-key
artifacts as cache misses. No historical artifact is silently trusted or re-signed
without verifying its original tag.

Project or instance enforcement rejects unsigned PUTs with 403. Multipart creation
checks the tag, and continuation/completion checks the authenticated upload ticket's
stored tag, so tightening policy also blocks old unsigned tickets. Enforcement is
presence/shape validation, not server-side body verification. Turbo verifies the
HMAC on download. Signing detects storage/transit corruption; a compromised trusted
job holding a key can still produce a correctly signed poisoned artifact.

Signature formats were checked against [Turbo 2.11.10 source](https://github.com/vercel/turborepo/blob/v2.11.10/crates/turborepo-cache/src/signature_authentication.rs).
See also [Turbo signing configuration](https://turborepo.dev/docs/core-concepts/remote-caching#artifact-integrity-and-authenticity-verification).

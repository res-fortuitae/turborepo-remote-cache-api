import { Database, schema } from "@repo/db";
import { AuditLog, type AuditInput } from "@repo/audit";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";

export const ARTIFACT_KEY_OVERLAP_MS = 24 * 3600000;
export class ArtifactSigningError extends Schema.TaggedError<ArtifactSigningError>()(
  "ArtifactSigningError",
  {},
) {}
/** Supplied from the existing Better Auth Secrets Store secret, domain-separated with HKDF. */
export class ArtifactEncryptionSecret extends Context.Service<
  ArtifactEncryptionSecret,
  { readonly get: Effect.Effect<Redacted.Redacted<string>, unknown> }
>()("@repo/credentials/ArtifactEncryptionSecret") {}
const encode = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (text: string) => Uint8Array.from(atob(text), (value) => value.charCodeAt(0));
const text = new TextEncoder();
const aad = (org: string, project: string, id: string) =>
  text.encode(JSON.stringify(["tcache-artifact-key:v1", org, project, id]));
const envelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  key: Schema.String,
  keyIv: Schema.String,
  ciphertext: Schema.String,
  iv: Schema.String,
});
const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(envelopeSchema));
const kek = async (secret: string) => {
  const material = await crypto.subtle.importKey("raw", text.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: text.encode("tcache-artifact-envelope:v1"),
      info: text.encode("key-encryption-key"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};
export async function encryptArtifactKey(
  secret: string,
  key: string,
  org: string,
  project: string,
  id: string,
) {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    keyIv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = aad(org, project, id);
  const keyObject = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["encrypt"]);
  const [ciphertext, wrapped] = await Promise.all([
    crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, keyObject, text.encode(key)),
    crypto.subtle.encrypt(
      { name: "AES-GCM", iv: keyIv, additionalData },
      await kek(secret),
      dataKey,
    ),
  ]);
  dataKey.fill(0);
  return JSON.stringify({
    version: 1,
    key: encode(wrapped),
    keyIv: encode(keyIv),
    ciphertext: encode(ciphertext),
    iv: encode(iv),
  });
}
export async function decryptArtifactKey(
  secret: string,
  envelope: string,
  org: string,
  project: string,
  id: string,
) {
  const value = decodeEnvelope(envelope),
    additionalData = aad(org, project, id);
  const dataKey = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(value.keyIv), additionalData },
      await kek(secret),
      decode(value.key),
    ),
  );
  const keyObject = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["decrypt"]);
  dataKey.fill(0);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(value.iv), additionalData },
      keyObject,
      decode(value.ciphertext),
    ),
  );
}

const make = Effect.gen(function* () {
  const db = yield* Database,
    audit = yield* AuditLog,
    encryption = yield* ArtifactEncryptionSecret;
  const active = (org: string, project: string, now: number) =>
    db.query("ArtifactSigning.keys", (q) =>
      q
        .select()
        .from(schema.artifactSigningKey)
        .where(
          and(
            eq(schema.artifactSigningKey.orgId, org),
            eq(schema.artifactSigningKey.projectId, project),
            or(
              isNull(schema.artifactSigningKey.retiredAt),
              gt(schema.artifactSigningKey.retiredAt, now),
            ),
          ),
        )
        .orderBy(
          sql`case when retired_at is null then 0 else 1 end`,
          desc(schema.artifactSigningKey.createdAt),
        )
        .limit(3),
    );
  return {
    status: (project: string) =>
      Effect.gen(function* () {
        const [settings] = yield* db.query("ArtifactSigning.settings", (q) =>
          q
            .select()
            .from(schema.artifactSigningSettings)
            .where(eq(schema.artifactSigningSettings.projectId, project)),
        );
        const keys = yield* db.query("ArtifactSigning.metadata", (q) =>
          q
            .select({
              id: schema.artifactSigningKey.id,
              createdAt: schema.artifactSigningKey.createdAt,
              retiredAt: schema.artifactSigningKey.retiredAt,
            })
            .from(schema.artifactSigningKey)
            .where(eq(schema.artifactSigningKey.projectId, project))
            .orderBy(
              sql`case when retired_at is null then 0 else 1 end`,
              desc(schema.artifactSigningKey.createdAt),
            )
            .limit(2),
        );
        return { required: settings?.required ?? false, keys };
      }).pipe(Effect.mapError(() => new ArtifactSigningError())),
    configure: (project: string, required: boolean, event: AuditInput) =>
      audit
        .commit({ ...event, action: "artifact.signing.configure", metadata: { required } }, (q) => [
          q
            .insert(schema.artifactSigningSettings)
            .values({ projectId: project, required })
            .onConflictDoUpdate({
              target: schema.artifactSigningSettings.projectId,
              set: { required },
            }),
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError(() => new ArtifactSigningError()),
        ),
    rotate: (org: string, project: string, event: AuditInput) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const keys = yield* active(org, project, now);
        // One prior key at most. Frequent rotation must not evict a key still in its promised overlap.
        if (keys.some((key) => key.retiredAt !== null)) return yield* new ArtifactSigningError();
        const id = crypto.randomUUID(),
          key = encode(crypto.getRandomValues(new Uint8Array(32)));
        const secret = Redacted.value(yield* encryption.get);
        const envelope = yield* Effect.tryPromise(() =>
          encryptArtifactKey(secret, key, org, project, id),
        );
        yield* audit.commit(
          {
            ...event,
            action: "artifact.signing.rotate",
            metadata: { keyId: id, overlapUntil: now + ARTIFACT_KEY_OVERLAP_MS },
          },
          (q) => [
            q
              .update(schema.artifactSigningKey)
              .set({ retiredAt: now + ARTIFACT_KEY_OVERLAP_MS })
              .where(
                and(
                  eq(schema.artifactSigningKey.projectId, project),
                  isNull(schema.artifactSigningKey.retiredAt),
                  sql`not exists (select 1 from artifact_signing_key where project_id = ${project} and retired_at > ${now})`,
                ),
              ),
            q
              .insert(schema.artifactSigningKey)
              .values({ id, orgId: org, projectId: project, envelope, createdAt: now }),
          ],
        );
        return { id };
      }).pipe(Effect.mapError(() => new ArtifactSigningError())),
    deliver: (org: string, project: string, event: AuditInput) =>
      Effect.gen(function* () {
        const keys = yield* active(org, project, yield* Clock.currentTimeMillis);
        if (keys.length === 0) return undefined;
        const secret = Redacted.value(yield* encryption.get);
        const values = yield* Effect.forEach(keys, (row) =>
          Effect.tryPromise(() => decryptArtifactKey(secret, row.envelope, org, project, row.id)),
        );
        yield* audit.commit(
          {
            ...event,
            action: "artifact.signing.access",
            metadata: { keyIds: keys.map((key) => key.id) },
          },
          () => [],
        );
        return {
          signatureKey: Redacted.make(values[0]!),
          previousSignatureKeys: values.slice(1).map((value) => Redacted.make(value)),
        };
      }).pipe(Effect.mapError(() => new ArtifactSigningError())),
  };
});
export class ArtifactSigning extends Context.Service<
  ArtifactSigning,
  Effect.Success<typeof make>
>()("@repo/credentials/ArtifactSigning") {}
export const ArtifactSigningLive = Layer.effect(ArtifactSigning, make);

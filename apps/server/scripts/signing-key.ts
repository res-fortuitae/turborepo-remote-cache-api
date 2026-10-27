import { writeFile } from "node:fs/promises";
import { SigningKeySet } from "@repo/credentials";
import { Schema } from "effect";

export const generateSigningKey = async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 key generation did not return a key pair");
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const kid = crypto.randomUUID();
  return JSON.stringify({ current: kid, keys: [{ ...jwk, kid }] });
};

export const validateSigningKey = async (value: string | undefined) => {
  try {
    const set = Schema.decodeUnknownSync(Schema.fromJsonString(SigningKeySet))(value);
    for (const key of set.keys)
      await crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    // Schema/crypto errors may contain private key material. Never include their cause.
    throw new Error(
      "CACHE_TOKEN_SIGNING_KEY must be a private Ed25519 SigningKeySet JSON. Generate one with `bun run keygen --out /private/path/signing-key.json`; store its single-line contents as the root secret.",
    );
  }
};

if (import.meta.main) {
  const [flag, output] = Bun.argv.slice(2);
  if (flag !== "--out" || !output || Bun.argv.length !== 4)
    throw new Error("Usage: bun run keygen --out /private/path/signing-key.json");
  await writeFile(output, `${await generateSigningKey()}\n`, { mode: 0o600, flag: "wx" });
  console.error(
    "Signing key written privately. Store its contents as CACHE_TOKEN_SIGNING_KEY; never commit it.",
  );
}

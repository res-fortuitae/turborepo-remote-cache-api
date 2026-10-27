import { expect, test } from "bun:test";
import { generateSigningKey, validateSigningKey } from "../apps/server/scripts/signing-key.ts";

test("deployment signing-key preflight accepts generated keys and rejects malformed secrets without disclosure", async () => {
  await expect(validateSigningKey(await generateSigningKey())).resolves.toBeUndefined();
  for (const secret of [
    undefined,
    "private-bad-secret",
    JSON.stringify({
      current: "key",
      keys: [{ kty: "OKP", crv: "Ed25519", kid: "key", x: "bad", d: "private-bad-secret" }],
    }),
  ]) {
    try {
      await validateSigningKey(secret);
      throw new Error("Invalid signing key was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("CACHE_TOKEN_SIGNING_KEY must");
      expect(String(error)).not.toContain("private-bad-secret");
    }
  }
});

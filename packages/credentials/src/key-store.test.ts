import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Result } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { KeyStore, KeyStoreError, KeyStoreLive, SigningKeySecret } from "./index.ts";

const load = (secret: () => Promise<string>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(
    KeyStore.use((store) => store.signingKeys).pipe(
      Effect.map(Redacted.value),
      Effect.result,
      Effect.provide(
        KeyStoreLive.pipe(Layer.provide(Layer.succeed(SigningKeySecret, { get: secret }))),
      ),
    ),
  );

const privateJwk = async (kid: string) => {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

  return { ...(await exportJWK(privateKey)), kid };
};

describe("KeyStoreLive", () => {
  test("decodes the secret's key set", async () => {
    const keys = [await privateJwk("k2"), await privateJwk("k1")];
    const result = await load(async () => JSON.stringify({ current: "k2", keys }));

    expect(Result.isSuccess(result) && result.success.keys.map((key) => key.kid)).toEqual([
      "k2",
      "k1",
    ]);
  });

  test("rejects public-only keys, an unknown current kid, more than two keys and read failures", async () => {
    const key = await privateJwk("k1");
    const { d: _, ...publicOnly } = key;

    const secrets = [
      { current: "k1", keys: [publicOnly] },
      { current: "k9", keys: [key] },
      { current: "k1", keys: [key, await privateJwk("k2"), await privateJwk("k3")] },
    ];

    for (const secret of secrets) {
      const result = await load(async () => JSON.stringify(secret));
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(KeyStoreError);
    }

    const unavailable = await load(() => Promise.reject(new Error("binding missing")));
    expect(Result.isFailure(unavailable) && unavailable.failure).toBeInstanceOf(KeyStoreError);
  });
});

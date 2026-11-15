import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ArtifactParams, ArtifactQueryRequest, CacheEvents } from "./cache.ts";
import { MultipartCreate } from "./uploads.ts";

test("direct and multipart hashes share boundaries", () => {
  for (const length of [0, 1, 256, 257]) {
    const hash = "A".repeat(length);
    for (const decode of [
      () => Schema.decodeUnknownSync(ArtifactParams)({ hash }),
      () => Schema.decodeUnknownSync(MultipartCreate)({ hash, size: 1 }),
    ]) {
      if (length === 1 || length === 256) expect(decode).not.toThrow();
      else expect(decode).toThrow();
    }
  }
});
test("query strings and event durations are bounded", () => {
  expect(() =>
    Schema.decodeUnknownSync(ArtifactQueryRequest)({ hashes: ["a".repeat(257)] }),
  ).toThrow();
  for (const duration of [-1, 86_400_001, Infinity]) {
    expect(() =>
      Schema.decodeUnknownSync(CacheEvents)([
        { sessionId: "s", hash: "a", source: "REMOTE", event: "HIT", duration },
      ]),
    ).toThrow();
  }
});

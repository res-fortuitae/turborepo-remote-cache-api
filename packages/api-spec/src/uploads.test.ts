import { expect, test } from "bun:test";
import { Schema } from "effect";
import { MultipartComplete } from "./uploads.ts";
const valid = Schema.is(MultipartComplete);
test("multipart manifests accept opaque R2 ETags longer than 128 characters while keeping a bound", () => {
  expect(valid({ parts: [{ partNumber: 1, etag: "a".repeat(176) }] })).toBe(true);
  expect(valid({ parts: [{ partNumber: 1, etag: "a".repeat(1024) }] })).toBe(true);
  expect(valid({ parts: [{ partNumber: 1, etag: "a".repeat(1025) }] })).toBe(false);
  expect(valid({ parts: [{ partNumber: 1, etag: "" }] })).toBe(false);
});

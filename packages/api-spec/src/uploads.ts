import { Schema } from "effect";

export const MULTIPART_PART_BYTES = 64 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = 10_000;
export const MAX_EDGE_ARTIFACT_BYTES = 512_000_000;
const positive = Schema.Int.check(Schema.isGreaterThan(0));
export const MultipartCreate = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]+$/), Schema.isMaxLength(256)),
  size: positive,
});
export const UploadedPart = Schema.Struct({
  partNumber: positive,
  etag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export const MultipartComplete = Schema.Struct({
  parts: Schema.Array(UploadedPart).check(Schema.isMaxLength(MAX_MULTIPART_PARTS)),
});
export const MultipartCreated = Schema.Struct({
  id: Schema.String,
  partSize: positive,
  expiresAt: positive,
});

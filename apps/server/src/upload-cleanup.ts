import type { R2Bucket } from "@cloudflare/workers-types";
import { Effect } from "effect";

/** R2 has no conditional delete. Replace only this upload's revision with an empty tombstone. */
export const invalidateUpload = (bucket: R2Bucket, key: string, session: string) =>
  Effect.tryPromise(async () => {
    const current = await bucket.head(key);
    if (!current || current.customMetadata?.uploadSession !== session) return false;
    const replaced = await bucket.put(key, new Uint8Array(), {
      onlyIf: {
        etagMatches: current.etag,
        uploadedBefore: new Date(current.uploaded.getTime() + 1),
      },
      customMetadata: { uploadSession: session, uploadInvalidated: "true" },
    });
    return replaced !== null;
  });

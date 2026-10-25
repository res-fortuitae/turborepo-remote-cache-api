import type { R2Bucket } from "@cloudflare/workers-types";
import { makeMultipartBucket } from "../../src/multipart-bucket.ts";
import { Effect, Stream } from "effect";
import type { UploadTicket } from "@repo/artifacts";

/** Exercises the production stream/R2 adapter in a real local workerd runtime. */
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket }) {
    const bucket = makeMultipartBucket(env.BUCKET);
    const size = Number(request.headers.get("content-length"));
    const key = "org/project/abc";
    const id = await Effect.runPromise(
      bucket.create(key, { uploadSession: "s", tag: "signature", duration: "42" }),
    );
    const ticket: UploadTicket = {
      uploadId: id,
      key,
      orgId: "org",
      projectId: "project",
      credentialId: "credential",
      hash: "abc",
      size,
      generation: 0,
      expiresAt: Date.now() + 10000,
      session: "s",
      provenance: {},
    };
    try {
      const part = await Effect.runPromise(
        bucket.part(
          ticket,
          1,
          Stream.fromReadableStream({ evaluate: () => request.body!, onError: (e) => e }),
          Number(new URL(request.url).searchParams.get("expected") ?? size),
        ),
      );
      await Effect.runPromise(bucket.complete(ticket, [part]));
      const object = await env.BUCKET.get(key);
      return Response.json({ bytes: await object!.text(), metadata: object!.customMetadata });
    } catch {
      await Effect.runPromise(bucket.abort(ticket));
      return new Response("Rejected", { status: 400 });
    }
  },
};

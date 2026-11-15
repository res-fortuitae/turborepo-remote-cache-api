import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";

test("R2 tee with an unread client branch buffers an entire 32 MiB object", async () => {
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: "2026-07-30",
    r2Buckets: ["BUCKET"],
    host: "127.0.0.1",
    port: 0,
    script: `export default { async fetch(request, env) {
      await env.BUCKET.put('artifact', new Uint8Array(32 * 1024 * 1024));
      const object = await env.BUCKET.get('artifact');
      const [client, copy] = object.body.tee();
      let bytes = 0, error = null;
      const reader = copy.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
        }
      } catch (cause) { error = String(cause); }
      await client.cancel().catch(() => {});
      return Response.json({ bytes, error });
    }};`,
  });
  try {
    const result = (await (await mf.dispatchFetch("http://localhost")).json()) as {
      bytes: number;
      error: string | null;
    };
    expect(result).toEqual({ bytes: 32 * 1024 * 1024, error: null });
  } finally {
    await mf.dispose();
  }
}, 30_000);

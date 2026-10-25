import { test, expect } from "bun:test";
import { Miniflare } from "miniflare";

test("production R2 adapter streams metadata and rejects actual body length mismatches in workerd", async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("./support/multipart-worker.ts", import.meta.url).pathname],
    target: "browser",
    minify: true,
  });
  if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join("\n"));
  const mf = new Miniflare({
    modules: true,
    script: await bundle.outputs[0]!.text(),
    compatibilityDate: "2026-07-30",
    r2Buckets: ["BUCKET"],
  });
  try {
    const response = await mf.dispatchFetch("http://localhost", {
      method: "PUT",
      body: "hello",
      headers: { "content-length": "5" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bytes: "hello",
      metadata: { uploadSession: "s", tag: "signature", duration: "42" },
    });
    const wrong = await mf.dispatchFetch("http://localhost?expected=6", {
      method: "PUT",
      body: "hello",
      headers: { "content-length": "5" },
    });
    expect(wrong.status).toBe(400);
  } finally {
    await mf.dispose();
  }
}, 30_000);

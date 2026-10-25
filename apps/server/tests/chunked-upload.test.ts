import { beforeAll, afterAll, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

let preview: Miniflare;
let api: string;
const headers = {
  authorization: "Bearer ephemeral",
  "x-artifact-duration": "42",
  "x-artifact-tag": "signed",
};

const streamed = (bytes: number) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!bytes) {
        controller.close();
        return;
      }
      const size = Math.min(bytes, 65536);
      controller.enqueue(new Uint8Array(size).fill(65));
      bytes -= size;
    },
  });

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./support/compatibility-worker.ts", import.meta.url))],
    target: "browser",
    minify: true,
    external: ["node:*"],
  });
  if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join("\n"));
  preview = new Miniflare({
    modules: true,
    script: await bundle.outputs[0]!.text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["BUCKET"],
    bindings: { TOKEN: "ephemeral" },
    host: "127.0.0.1",
    port: 0,
  });
  api = (await preview.ready).origin;
}, 30_000);

afterAll(async () => {
  await preview?.dispose();
});

test("chunked upload spans R2 parts and preserves bytes, signatures and provenance", async () => {
  const size = 6 * 1024 * 1024 + 7;
  const response = await fetch(`${api}/v8/artifacts/abc`, {
    method: "PUT",
    headers,
    body: streamed(size),
  });
  expect(response.status).toBe(202);
  const downloaded = await fetch(`${api}/v8/artifacts/abc`, { headers });
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("x-artifact-tag")).toBe("signed");
  expect(downloaded.headers.get("x-artifact-duration")).toBe("42");
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  expect(bytes.length).toBe(size);
  expect(bytes.every((byte) => byte === 65)).toBe(true);
  const stored = await (await preview.getR2Bucket("BUCKET")).head("default/abc");
  expect(stored?.customMetadata).toMatchObject({
    credentialType: "legacy",
    credentialId: "legacy",
    tag: "signed",
  });
});

test("chunked upload exceeding the live limit aborts and leaves no completed artifact", async () => {
  const response = await fetch(`${api}/v8/artifacts/def`, {
    method: "PUT",
    // A rejected streamed body resets reused workerd sockets; use a fresh connection.
    keepalive: false,
    headers,
    body: streamed(13 * 1024 * 1024),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: "payload_too_large" });
  expect(
    (await fetch(`${api}/v8/artifacts/def`, { method: "HEAD", headers, keepalive: false })).status,
  ).toBe(404);
});

test("empty unknown-length bodies commit a valid zero-byte object", async () => {
  const response = await fetch(`${api}/v8/artifacts/aaa`, {
    method: "PUT",
    headers,
    body: streamed(0),
  });
  expect(response.status).toBe(202);
  expect((await (await preview.getR2Bucket("BUCKET")).head("default/aaa"))?.size).toBe(0);
});

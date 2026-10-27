import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const field = (value: string | number) => {
  const bytes = typeof value === "string" ? Buffer.from(value) : undefined;
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes?.length ?? value));
  return bytes ? Buffer.concat([length, bytes]) : length;
};
export const signatureMac = (
  key: string,
  hash: string,
  team: string,
  bytes: number,
  version: "v1" | "v2",
) => {
  const mac = createHmac("sha256", key);
  if (version === "v1") mac.update(JSON.stringify({ hash, teamId: team }));
  else {
    mac.update(field("artifact-signature:v2"));
    mac.update(field(hash));
    mac.update(field(team));
    mac.update(field(bytes));
  }
  return mac;
};

/** Only rotation overlap uses disk. Verify an old tag before translating it for a job's pinned key. */
export async function bridgeRotatedSignature(
  response: Response,
  hash: string,
  team: string,
  pinned: string,
  keys: ReadonlyArray<string>,
  signal: AbortSignal,
) {
  const tag = response.headers.get("x-artifact-tag");
  if (!tag || !response.body || !/^[A-Za-z0-9+/]{43}=$/.test(tag)) {
    await response.body?.cancel();
    return new Response(null, { status: 502 });
  }
  const directory = await mkdtemp(join(tmpdir(), "tcache-signature-"));
  const file = await open(join(directory, "artifact"), "wx+", 0o600);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await file.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error("aborted");
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2_147_483_648) throw new Error("artifact too large");
        await file.writeFile(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const macs = keys.flatMap((key) =>
      (["v2", "v1"] as const).map((version) => ({
        key,
        version,
        mac: signatureMac(key, hash, team, size, version),
      })),
    );
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      for (const entry of macs) entry.mac.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const expected = Buffer.from(tag, "base64");
    const tags = macs.map((entry) => ({ ...entry, digest: entry.mac.digest() }));
    const matched = tags.find(
      (entry) => entry.digest.length === expected.length && timingSafeEqual(entry.digest, expected),
    );
    if (!matched) {
      await cleanup();
      return new Response(null, { status: 502 });
    }
    const translated = tags.find(
      (entry) => entry.key === pinned && entry.version === matched.version,
    );
    if (!translated) throw new Error("pinned signing key expired");
    const headers = new Headers(response.headers);
    headers.set("x-artifact-tag", translated.digest.toString("base64"));
    headers.set("content-length", String(size));
    let position = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (signal.aborted) throw new Error("aborted");
          const bytes = new Uint8Array(65536);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
          if (!bytesRead) {
            await cleanup();
            controller.close();
            return;
          }
          position += bytesRead;
          controller.enqueue(bytes.subarray(0, bytesRead));
        } catch (cause) {
          await cleanup();
          controller.error(cause);
        }
      },
      async cancel() {
        await cleanup();
      },
    });
    return new Response(stream, { status: response.status, headers });
  } catch {
    await cleanup();
    return new Response(null, { status: 502 });
  }
}

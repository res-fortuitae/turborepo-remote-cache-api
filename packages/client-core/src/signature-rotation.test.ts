import { expect, test } from "bun:test";
import { bridgeRotatedSignature, signatureMac } from "./signature-rotation.ts";

for (const version of ["v1", "v2"] as const) {
  test(`${version}: old signatures remain valid through rotation and tampering is rejected`, async () => {
    const old = "old-artifact-key-at-least-32-bytes",
      current = "new-artifact-key-at-least-32-bytes";
    const body = new TextEncoder().encode("signed archive");
    const tag = signatureMac(old, "abcdef", "team_test", body.length, version)
      .update(body)
      .digest("base64");
    const signal = new AbortController().signal;
    const response = await bridgeRotatedSignature(
      new Response(body, { headers: { "x-artifact-tag": tag } }),
      "abcdef",
      "team_test",
      current,
      [current, old],
      signal,
    );
    expect(response.status).toBe(200);
    const downloaded = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("x-artifact-tag")).toBe(
      signatureMac(current, "abcdef", "team_test", downloaded.length, version)
        .update(downloaded)
        .digest("base64"),
    );
    const bad = await bridgeRotatedSignature(
      new Response("tampered", { headers: { "x-artifact-tag": tag } }),
      "abcdef",
      "team_test",
      current,
      [current, old],
      signal,
    );
    expect(bad.status).toBe(502);
  });
}

import { expect, test } from "bun:test";
import { mkdtemp, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadArtifact } from "./uploads.ts";

const withFile = async (size: number, task: (artifact: Blob) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "upload-client-"));
  const path = join(directory, "artifact");
  try {
    await writeFile(path, "");
    await truncate(path, size);
    await task(Bun.file(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("small artifacts use a single PUT and forward only artifact metadata", () =>
  withFile(50_000_000, async (artifact) => {
    let calls = 0;
    await uploadArtifact({
      server: "http://localhost",
      token: () => "fresh",
      hash: "abc",
      artifact,
      headers: { "x-artifact-tag": "signed", authorization: "spoof", origin: "https://evil.test" },
      fetch: async (url, init) => {
        calls++;
        expect(url.pathname).toBe("/v8/artifacts/abc");
        expect(init.headers).toEqual({
          authorization: "Bearer fresh",
          "content-length": "50000000",
          "x-artifact-tag": "signed",
        });
        expect(init.redirect).toBe("error");
        return new Response(null, { status: 202 });
      },
    });
    expect(calls).toBe(1);
  }));

test("1 GB source uses at most four parts, retries one failure and completes in order", () =>
  withFile(1_000_000_000, async (artifact) => {
    let active = 0,
      maximum = 0,
      calls = 0,
      retried = false;
    const sizes: number[] = [];
    await uploadArtifact({
      server: "http://localhost",
      token: () => "fresh",
      hash: "abc",
      artifact,
      fetch: async (url, init) => {
        calls++;
        if (url.pathname === "/v8/x/uploads")
          return Response.json(
            { id: "upload", partSize: 64 * 1024 * 1024, expiresAt: Date.now() + 10000 },
            { status: 201 },
          );
        const part = /\/parts\/(\d+)$/.exec(url.pathname);
        if (part) {
          const number = Number(part[1]);
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          if (number === 2 && !retried) {
            retried = true;
            return new Response(null, { status: 503 });
          }
          sizes[number - 1] = Number(new Headers(init.headers).get("content-length"));
          return Response.json({ partNumber: number, etag: `etag-${number}` });
        }
        expect(url.pathname).toBe("/v8/x/uploads/upload/complete");
        expect(
          JSON.parse(String(init.body)).parts.map((p: { partNumber: number }) => p.partNumber),
        ).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
        return new Response(null, { status: 202 });
      },
    });
    expect(maximum).toBe(4);
    expect(retried).toBe(true);
    expect(calls).toBe(18);
    expect(sizes.reduce((n, s) => n + s, 0)).toBe(1_000_000_000);
    expect(sizes.slice(0, -1).every((s) => s === 64 * 1024 * 1024)).toBe(true);
  }));

test("permanent part failures stop remaining work and abort even if the caller cancelled", () =>
  withFile(150_000_000, async (artifact) => {
    let aborted = false;
    await expect(
      uploadArtifact({
        server: "http://localhost",
        token: () => "fresh",
        hash: "abc",
        artifact,
        fetch: async (url) => {
          if (url.pathname === "/v8/x/uploads")
            return Response.json({
              id: "upload",
              partSize: 64 * 1024 * 1024,
              expiresAt: Date.now() + 10000,
            });
          if (url.pathname.endsWith("/abort")) {
            aborted = true;
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 403 });
        },
      }),
    ).rejects.toThrow("403");
    expect(aborted).toBe(true);
  }));

test("completion can be retried after a lost response without aborting a committed upload", () =>
  withFile(70_000_000, async (artifact) => {
    let completed = 0,
      aborted = false;
    await uploadArtifact({
      server: "http://localhost",
      token: () => "fresh",
      hash: "abc",
      artifact,
      fetch: async (url) => {
        if (url.pathname === "/v8/x/uploads")
          return Response.json({
            id: "upload",
            partSize: 64 * 1024 * 1024,
            expiresAt: Date.now() + 10000,
          });
        if (url.pathname.endsWith("/complete")) {
          completed++;
          if (completed === 1) throw new Error("Connection lost after commit");
          return new Response(null, { status: 202 });
        }
        if (url.pathname.endsWith("/abort")) {
          aborted = true;
          return new Response(null, { status: 204 });
        }
        return Response.json({ partNumber: Number(url.pathname.split("/").at(-1)), etag: "etag" });
      },
    });
    expect(completed).toBe(2);
    expect(aborted).toBe(false);
  }));

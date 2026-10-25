import { expect, test } from "bun:test";
import type { CapabilityReport } from "@repo/shared";
import { doctorServer, formatCapabilities } from "./index.ts";

const feature = {
  enabled: false,
  reason: "Workers Paid required",
  fallback: "D1 only",
  upgrade: "Enable Workers Paid",
};

const report: CapabilityReport = {
  schemaVersion: 1,
  workersPlan: "unknown",
  zonePlan: "none",
  emailSending: feature,
  analytics: feature,
  auditHistory: feature,
  directUploads: feature,
  analyticsMode: "lite",
  auditRetentionDays: 365,
  warnings: ["Probe denied"],
};

test("doctor reads and validates the server contract and redacts credentials from output", async () => {
  const requests: { url: string; authorization: string | null }[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });

      return Response.json(report);
    },
  });

  try {
    const result = await doctorServer({ server: server.url.origin, token: "test-secret" });
    expect(result).toEqual(report);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/instance/capabilities");
    expect(requests[0]!.authorization).toBe("Bearer test-secret");
    const output = formatCapabilities(result);
    expect(output).toContain("Fallback: D1 only");
    expect(output).toContain("Warning: Probe denied");
    expect(output).not.toContain("test-secret");
  } finally {
    await server.stop(true);
  }
});

test("doctor rejects a legacy response, redirects, and unauthorized servers", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const auth = request.headers.get("authorization");

      if (auth === "Bearer redirect") return Response.redirect("https://example.com");

      if (auth === "Bearer legacy") return Response.json({ status: "enabled" });

      return new Response("unauthorized", { status: 401 });
    },
  });

  try {
    await expect(doctorServer({ server: server.url.origin, token: "bad" })).rejects.toThrow(
      "HTTP 401",
    );
    await expect(doctorServer({ server: server.url.origin, token: "legacy" })).rejects.toThrow();
    await expect(doctorServer({ server: server.url.origin, token: "redirect" })).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

test.each([
  "http://example.com",
  "https://user:pass@example.com",
  "https://example.com/path",
  "https://example.com?token=x",
])("doctor rejects unsafe origin %s before sending credentials", async (server) => {
  await expect(doctorServer({ server, token: "test" })).rejects.toThrow();
});

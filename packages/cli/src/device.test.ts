import { expect, test } from "bun:test";
import { deviceLogin } from "./device.ts";

test.each([
  { expiresIn: 900, interval: 301, statuses: [429, 503], polls: [301, 607], end: 900 },
  { expiresIn: 2_000, interval: 600, statuses: [429], polls: [600], end: 900 },
  { expiresIn: 12, interval: 5, statuses: [429], polls: [5], end: 12 },
  { expiresIn: 5, interval: 5, statuses: [], polls: [], end: 5 },
])("device login backs off and stops at the bounded lifetime $expiresIn", async (fixture) => {
  let elapsed = 0;
  const polls: number[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/device/code")
        return Response.json({
          device_code: "device",
          user_code: "CODE1234",
          verification_uri: `${server.url.origin}/device`,
          expires_in: fixture.expiresIn,
          interval: fixture.interval,
        });
      if (path !== "/api/auth/device/token") return new Response(null, { status: 404 });
      polls.push(elapsed / 1000);
      return new Response("<html>Temporarily unavailable</html>", {
        headers: { "content-type": "text/html" },
        status: fixture.statuses[polls.length - 1] ?? 500,
      });
    },
  });
  try {
    await expect(
      deviceLogin(server.url.origin, () => undefined, undefined, true, {
        now: () => elapsed,
        wait: async (ms) => {
          elapsed += ms;
        },
      }),
    ).rejects.toThrow("Device request expired.");
    expect(polls).toEqual([...fixture.polls]);
    expect(elapsed / 1000).toBe(fixture.end);
  } finally {
    await server.stop(true);
  }
});

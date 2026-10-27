#!/usr/bin/env bun
import { deviceLogin } from "./device.ts";
import { runAuthCommand } from "./commands.ts";
import { adminPurge } from "./purge.ts";
import { doctorServer, formatCapabilities } from "./index.ts";

const args = Bun.argv.slice(2);

if (args[0] === "login") {
  try {
    await deviceLogin(
      args[args.indexOf("--api") + 1] && args.includes("--api")
        ? args[args.indexOf("--api") + 1]!
        : (Bun.env.TCACHE_API ?? Bun.env.TURBO_API ?? ""),
    );
  } catch {
    console.error("Login failed. Check the instance URL and device approval, then retry.");
    process.exitCode = 1;
  }
} else if (["exec", "proxy", "env", "proxy-stop"].includes(args[0] ?? "")) {
  process.exitCode = await runAuthCommand(args);
} else if (args[0] === "admin" && args[1] === "purge") {
  try {
    console.log(
      JSON.stringify(
        await adminPurge(args.slice(2), {
          server: Bun.env.TURBO_API,
          cookie: Bun.env.TCACHE_SESSION_COOKIE,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^(Set |Purge request|Confirm |Missing |An HTTPS)/.test(error.message)
        ? error.message
        : "Purge request failed. Check the filter, server and session.",
    );
    process.exitCode = 1;
  }
} else if (args[0] !== "doctor" || !args.includes("--server")) {
  console.error(
    "Usage: bun packages/cli/src/bin.ts doctor --server [https://cache.example.com] [--json]\nUses TURBO_API and TURBO_TOKEN. Other doctor checks are pending STV-489.",
  );
  process.exitCode = 1;
} else {
  const candidate = args[args.indexOf("--server") + 1];
  const server = candidate && !candidate.startsWith("--") ? candidate : Bun.env.TURBO_API;
  const token = Bun.env.TURBO_TOKEN;

  if (!server || !token) {
    console.error("Set TURBO_API (or pass --server URL) and TURBO_TOKEN.");
    process.exitCode = 1;
  } else {
    try {
      const report = await doctorServer({ server, token });
      console.log(
        args.includes("--json") ? JSON.stringify(report, null, 2) : formatCapabilities(report),
      );
    } catch (error) {
      // Do not print fetch errors: they may include request headers.
      console.error(
        error instanceof Error && error.message.startsWith("Server capability check failed")
          ? error.message
          : "Unable to read server capabilities. Check the URL, network, and server version.",
      );
      process.exitCode = 1;
    }
  }
}

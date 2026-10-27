#!/usr/bin/env bun
import { Effect } from "effect";
import { runCli } from "./cli.ts";

await Effect.runPromise(runCli(Bun.argv.slice(2))).catch(() => {
  // Parser prints help; operational errors never print raw causes or credentials.
  console.error("tcache failed. Check command help, login, and instance configuration.");
  process.exitCode = 1;
});

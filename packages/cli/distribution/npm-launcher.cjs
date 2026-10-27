#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const { join, dirname } = require("node:path");
const metadata = require("./package.json");
const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${musl ? "-musl" : ""}`;
try {
  const packageName = `${metadata.name}-${target}`;
  const manifest = require.resolve(`${packageName}/package.json`);
  const file = process.platform === "win32" ? "tcache.exe" : "tcache";
  const binary = join(dirname(manifest), file);
  const child = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", env: process.env });
  if (child.error) throw child.error;
  if (child.signal) process.kill(process.pid, child.signal);
  else process.exitCode = child.status ?? 1;
} catch {
  console.error(
    `Unable to run tcache for ${target}. Install with optional dependencies enabled or use a verified release binary.`,
  );
  process.exitCode = 1;
}

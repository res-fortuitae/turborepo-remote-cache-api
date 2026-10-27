export const targets = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl-baseline",
  "linux-arm64-musl": "bun-linux-arm64-musl",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64-baseline",
} as const;
export type Target = keyof typeof targets;
export const filename = (target: Target) =>
  `tcache-${target}${target.startsWith("windows") ? ".exe" : ""}`;
export const SIZE_BUDGET_BYTES = 128 * 1024 * 1024;
export const STARTUP_BUDGET_MS = 500;

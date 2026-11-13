import { fileURLToPath } from "node:url";
import { filename, SIZE_BUDGET_BYTES, STARTUP_BUDGET_MS, type Target } from "./targets.ts";
import { stat } from "node:fs/promises";
import packageJson from "../package.json" with { type: "json" };
const target =
  `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as Target;
const path = fileURLToPath(new URL(`../dist/${filename(target)}`, import.meta.url));
const timings: number[] = [];
for (let i = 0; i < 20; i++) {
  const started = performance.now();
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0 || output.trim() !== `tcache v${packageJson.version}`)
    throw new Error("Binary smoke check failed");
  timings.push(performance.now() - started);
}
timings.sort((a, b) => a - b);
const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
const size = (await stat(path)).size;
console.log(
  JSON.stringify(
    {
      target,
      bytes: size,
      startupP95Ms: p95,
      sizeBudgetBytes: SIZE_BUDGET_BYTES,
      startupBudgetMs: STARTUP_BUDGET_MS,
    },
    null,
    2,
  ),
);
if (size > SIZE_BUDGET_BYTES || p95 > STARTUP_BUDGET_MS) throw new Error("Binary budget exceeded");

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { filename, targets, type Target } from "./targets.ts";
const sums: string[] = [];
for (const target of Object.keys(targets)) {
  // SAFETY: keys are enumerated from the fixed target map.
  const name = filename(target as Target);
  const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
}
await writeFile(new URL("../dist/SHA256SUMS", import.meta.url), sums.sort().join("\n") + "\n");

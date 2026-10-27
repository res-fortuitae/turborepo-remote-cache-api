import { fileURLToPath } from "node:url";
import { bundledLicenses } from "./licenses.ts";
import { mkdir, stat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { filename, targets, SIZE_BUDGET_BYTES, type Target } from "./targets.ts";

if (Bun.version !== "1.4.3") throw new Error("Release builds require pinned Bun 1.4.3");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(output, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [join(root, "packages/cli/src/bin.ts")],
  target: "bun",
  minify: true,
  metafile: true,
});
if (!bundle.success) throw new Error("License inventory bundle failed");
await writeFile(
  join(output, "THIRD_PARTY_LICENSES.txt"),
  await bundledLicenses(Object.keys(bundle.metafile?.inputs ?? {}), process.cwd()),
);
await writeFile(
  join(output, "LICENSE.bun"),
  await readFile(new URL("../distribution/LICENSE.bun", import.meta.url), "utf8"),
);
const requested = Bun.argv.slice(2);
const names = requested.includes("--all")
  ? Object.keys(targets)
  : [
      requested[0] ??
        `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    ];
for (const name of names) {
  if (!(name in targets)) throw new Error(`Unsupported build target: ${name}`);
  // SAFETY: membership checked against the fixed release target map above.
  const target = name as Target;
  const result = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${targets[target]}`,
      "--minify",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "packages/cli/src/bin.ts",
      "--outfile",
      join(output, filename(target)),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await result.exited) !== 0) throw new Error(`Build failed: ${name}`);
  const info = await stat(join(output, filename(target)));
  if (info.size > SIZE_BUDGET_BYTES) throw new Error(`Size budget exceeded: ${name}`);
}
const checksums: string[] = [];
for (const name of (await readdir(output)).sort()) {
  if (!/^tcache-(linux|darwin|windows)-/.test(name)) continue;
  const bytes = await readFile(join(output, name));
  checksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
}
await writeFile(join(output, "SHA256SUMS"), checksums.join("\n") + "\n");

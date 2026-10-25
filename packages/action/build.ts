import { dirname, join, resolve } from "node:path";
import { readdir } from "node:fs/promises";

// Build-time only: no package manager or compiler runs inside the action.
const check = Bun.argv.includes("--check");

const result = await Bun.build({
  entrypoints: ["./src/main.ts", "./src/daemon.ts", "./src/post.ts"],
  target: "node",
  format: "cjs",
  minify: true,
  sourcemap: "none",
  naming: "[name].cjs",
  metafile: true,
});

if (!result.success) throw new AggregateError(result.logs, "Action bundle failed");

const outputs = new Map<string, string>();

for (const output of result.outputs)
  outputs.set(output.path.split("/").at(-1)!, await output.text());

const licenses = new Map<string, string>();

for (const input of Object.keys(result.metafile?.inputs ?? {})) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(resolve(input));

  for (;;) {
    if (await Bun.file(join(directory, "package.json")).exists()) {
      const info = await Bun.file(join(directory, "package.json")).json();
      const id = `${info.name}@${info.version}`;

      if (licenses.has(id)) break;

      const files = (await readdir(directory))
        .filter((name) => /^(license|licence|notice)(\.|$)/i.test(name))
        .sort();

      if (files.length === 0) throw new Error(`Missing bundled dependency license: ${id}`);
      const texts = await Promise.all(files.map((name) => Bun.file(join(directory, name)).text()));
      licenses.set(id, `${id}\n${texts.join("\n")}`);
      break;
    }

    const parent = dirname(directory);

    if (parent === directory) throw new Error(`Missing package metadata for ${input}`);
    directory = parent;
  }
}

outputs.set(
  "THIRD_PARTY_LICENSES.txt",
  [...licenses]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .join("\n\n----------\n\n"),
);

for (const [name, built] of outputs) {
  const path = `dist/${name}`;

  if (check) {
    if (!(await Bun.file(path).exists()) || (await Bun.file(path).text()) !== built)
      throw new Error(`Stale action bundle: ${path}`);
  } else await Bun.write(path, built);
}

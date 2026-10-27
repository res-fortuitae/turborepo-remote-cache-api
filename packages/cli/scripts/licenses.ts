import { dirname, join, resolve } from "node:path";
import { readdir } from "node:fs/promises";

/** Keep attribution for the dependency modules actually bundled into the executable. */
export const bundledLicenses = async (inputs: readonly string[], root: string) => {
  const licenses = new Map<string, string>();
  for (const input of inputs) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(root, input));
    for (;;) {
      if (await Bun.file(join(directory, "package.json")).exists()) {
        const info = await Bun.file(join(directory, "package.json")).json();
        const id = `${info.name}@${info.version}`;
        if (licenses.has(id)) break;
        const files = (await readdir(directory))
          .filter((name) => /^(license|licence|notice)(\.|$)/i.test(name))
          .sort();
        if (!files.length) throw new Error(`Missing bundled dependency license: ${id}`);
        const texts = await Promise.all(
          files.map((name) => Bun.file(join(directory, name)).text()),
        );
        licenses.set(id, `${id}\n${texts.join("\n")}`);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Missing metadata: ${input}`);
      directory = parent;
    }
  }
  return [...licenses]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .join("\n\n----------\n\n");
};

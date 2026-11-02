import { fileURLToPath } from "node:url";
import { mkdir, copyFile, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { filename, targets, type Target } from "./targets.ts";
const version = "0.1.0";
const scope = process.env.TCACHE_NPM_SCOPE;
if (!scope)
  throw new Error(
    "Choose TCACHE_NPM_SCOPE only when preparing publication. Local binaries need no npm name.",
  );
if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) throw new Error("Invalid npm scope");
const output = fileURLToPath(new URL("../dist/npm/", import.meta.url));
await mkdir(output, { recursive: true });
const optionalDependencies: Record<string, string> = {};
for (const name of Object.keys(targets)) {
  // SAFETY: keys come directly from the fixed target map.
  const target = name as Target;
  const directory = join(output, `tcache-${target}`);
  await mkdir(directory, { recursive: true });
  const packageName = `${scope}/tcache-${target}`;
  optionalDependencies[packageName] = version;
  const [os, cpu] = name.split("-");
  const file = os === "windows" ? "tcache.exe" : "tcache";
  await copyFile(new URL(`../dist/${filename(target)}`, import.meta.url), join(directory, file));
  await chmod(join(directory, file), 0o755);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version,
        description: `tcache native binary (${target})`,
        license: "UNLICENSED",
        os: [os === "windows" ? "win32" : os],
        cpu: [cpu],
        ...(os === "linux" ? { libc: [name.endsWith("musl") ? "musl" : "glibc"] } : {}),
        files: [file, "THIRD_PARTY_LICENSES.txt", "LICENSE.bun"],
        repository: {
          type: "git",
          url: "git+https://github.com/res-fortuitae/turborepo-remote-cache-api.git",
        },
        publishConfig: { access: "public", provenance: true },
      },
      null,
      2,
    ),
  );
  await copyFile(new URL("../dist/LICENSE.bun", import.meta.url), join(directory, "LICENSE.bun"));
  await copyFile(
    new URL("../dist/THIRD_PARTY_LICENSES.txt", import.meta.url),
    join(directory, "THIRD_PARTY_LICENSES.txt"),
  );
}
const directory = join(output, "tcache");
await mkdir(directory, { recursive: true });
await copyFile(
  new URL("../distribution/npm-launcher.cjs", import.meta.url),
  join(directory, "bin.cjs"),
);
await copyFile(
  new URL("../dist/THIRD_PARTY_LICENSES.txt", import.meta.url),
  join(directory, "THIRD_PARTY_LICENSES.txt"),
);
await writeFile(
  join(directory, "README.md"),
  await readFile(new URL("../../../docs/cli-distribution.md", import.meta.url), "utf8"),
);
await writeFile(
  join(directory, "package.json"),
  JSON.stringify(
    {
      name: `${scope}/tcache`,
      version,
      description: "Self-hosted Turborepo remote cache CLI",
      license: "UNLICENSED",
      bin: { tcache: "bin.cjs" },
      files: ["bin.cjs", "THIRD_PARTY_LICENSES.txt", "README.md"],
      engines: { node: ">=22" },
      optionalDependencies,
      repository: {
        type: "git",
        url: "git+https://github.com/res-fortuitae/turborepo-remote-cache-api.git",
      },
      publishConfig: { access: "public", provenance: true },
    },
    null,
    2,
  ),
);

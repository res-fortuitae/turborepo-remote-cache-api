import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Generate against a disposable copy: CI must never silently create migrations.
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "repo-db-schema-"));

try {
  const source = new URL("../migrations/", import.meta.url);
  const output = NodePath.join(temporary, "migrations");
  await NodeFSP.cp(source, output, { recursive: true });
  const before = (await NodeFSP.readdir(output)).sort();

  const result = Bun.spawnSync(
    [
      "bun",
      "x",
      "drizzle-kit",
      "generate",
      "--dialect",
      "sqlite",
      "--schema",
      "./src/schema/index.ts",
      "--out",
      output,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  if (result.exitCode !== 0) throw new Error("Schema check could not generate migrations");
  const after = (await NodeFSP.readdir(output)).sort();

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      "Schema has uncommitted changes. Run bun run db:generate and commit its migration.",
    );
  }
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}

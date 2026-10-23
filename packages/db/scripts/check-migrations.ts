import * as NodeFSP from "node:fs/promises";

/** Conservative additive-only gate. Keep migrations immutable after deployment. */
export function checkMigration(sql: string): string[] {
  const statements = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  return statements.filter(
    (statement) =>
      !/^(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b|ALTER\s+TABLE\s+\S+\s+ADD\s+(?:COLUMN\s+)?(?!CONSTRAINT\b)\S+)/i.test(
        statement,
      ),
  );
}

if (import.meta.main) {
  const directory = new URL("../migrations/", import.meta.url);

  for (const entry of await NodeFSP.readdir(directory)) {
    if (!/^\d+_/.test(entry)) continue;
    const sql = await NodeFSP.readFile(new URL(`${entry}/migration.sql`, directory), "utf8");
    const rejected = checkMigration(sql);

    if (rejected.length) throw new Error(`Non-additive migration ${entry}: ${rejected.join("; ")}`);
  }

  console.log("All migrations are additive.");
}

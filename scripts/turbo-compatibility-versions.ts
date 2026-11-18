/** Release guard: update the workflow and supported-versions table together. */
import { Schema } from "effect";

const decodeRegistry = Schema.decodeUnknownSync(
  Schema.Struct({ versions: Schema.Record(Schema.String, Schema.Unknown) }),
);

const decodeWorkflow = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      matrix: Schema.Struct({
        strategy: Schema.Struct({
          matrix: Schema.Struct({ turbo: Schema.Array(Schema.String) }),
        }),
      }),
    }),
  }),
);

export const documentsCompatibilityVersion = (workflow: string, docs: string, version: string) => {
  const { jobs } = decodeWorkflow(Bun.YAML.parse(workflow));

  return (
    jobs.matrix.strategy.matrix.turbo.includes(version) &&
    docs
      .split(/\r?\n/)
      .some((line) => /^\s*\|/.test(line) && line.split("|")[1]?.trim() === version)
  );
};

if (import.meta.main && Bun.argv.includes("--check-latest")) {
  const response = await fetch("https://registry.npmjs.org/turbo", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Unable to check Turbo versions in npm");
  const registry = decodeRegistry(await response.json());
  const stable = Object.keys(registry.versions).filter((version) =>
    /^\d+\.\d+\.\d+$/.test(version),
  );
  const sorted = (values: string[]) =>
    values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = sorted(stable.filter((version) => version.startsWith("2."))).at(-1)!;
  const previousMinor = Number(latest.split(".")[1]) - 1;
  const previous = sorted(stable.filter((version) => version.startsWith(`2.${previousMinor}.`))).at(
    -1,
  )!;
  const v1 = sorted(stable.filter((version) => version.startsWith("1."))).at(-1)!;
  const workflow = await Bun.file(
    new URL("../.github/workflows/turbo-compatibility.yml", import.meta.url),
  ).text();
  const docs = await Bun.file(new URL("../docs/turbo-compatibility.md", import.meta.url)).text();
  for (const version of [latest, previous, v1]) {
    if (!documentsCompatibilityVersion(workflow, docs, version))
      throw new Error(
        `Update Turbo compatibility workflow and docs for ${version}, then run the matrix before release`,
      );
  }
  console.log(`Turbo compatibility selection is current: ${latest}, ${previous}, ${v1}`);
}

/** Release guard: update the workflow and supported-versions table together. */
import { Schema } from "effect";

const Registry = Schema.Struct({ versions: Schema.Record(Schema.String, Schema.Unknown) });

if (Bun.argv.includes("--check-latest")) {
  const response = await fetch("https://registry.npmjs.org/turbo", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Unable to check Turbo versions in npm");
  const registry = Schema.decodeUnknownSync(Registry)(await response.json());
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
    if (
      !workflow.includes(version) ||
      !new RegExp(`\\|\\s*${version.replaceAll(".", "\\.")}\\s*\\|`).test(docs)
    )
      throw new Error(
        `Update Turbo compatibility workflow and docs for ${version}, then run the matrix before release`,
      );
  }
  console.log(`Turbo compatibility selection is current: ${latest}, ${previous}, ${v1}`);
}

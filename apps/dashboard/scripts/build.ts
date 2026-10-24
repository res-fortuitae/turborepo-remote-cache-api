import * as NodeFSP from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const directory = new URL("../dist/", import.meta.url);

await NodeFSP.rm(directory, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [new URL("../index.html", import.meta.url).pathname],
  outdir: directory.pathname,
  target: "browser",
  minify: true,
  plugins: [tailwind],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) throw new AggregateError(result.logs, "Dashboard build failed");

await NodeFSP.copyFile(
  new URL("../public/_headers", import.meta.url),
  new URL("_headers", directory),
);

console.log(`Built dashboard (${result.outputs.length} assets).`);

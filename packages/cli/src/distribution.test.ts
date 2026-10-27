import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const installer = new URL("../distribution/install.sh", import.meta.url).pathname;
for (const valid of [true, false])
  test(`installer ${valid ? "accepts verified bytes" : "rejects modified bytes before installation"}`, async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "tcache-install-"));
    try {
      await mkdir(join(directory, "mock"));
      const expected = "verified binary bytes";
      await writeFile(join(directory, "binary"), valid ? expected : "tampered bytes");
      const hash = createHash("sha256").update(expected).digest("hex");
      const target = `tcache-${process.platform}-${process.arch}`;
      await writeFile(join(directory, "SHA256SUMS"), `${hash}  ${target}\n`);
      await writeFile(
        join(directory, "mock/curl"),
        '#!/usr/bin/env bun\nimport { copyFile } from "node:fs/promises"; const args=Bun.argv.slice(2); const url=args.find(x=>x.startsWith("https://")); await copyFile(Bun.env.FIXTURE + (url.endsWith("SHA256SUMS") ? "/SHA256SUMS" : "/binary"), args[args.indexOf("-o")+1]);\n',
        { mode: 0o755 },
      );
      const child = Bun.spawn(["sh", installer, "v0.1.0"], {
        env: {
          ...Bun.env,
          PATH: `${directory}/mock:${Bun.env.PATH}`,
          FIXTURE: directory,
          TCACHE_INSTALL_DIR: join(directory, "destination"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(valid ? 0 : 1);
      if (valid)
        expect(await readFile(join(directory, "destination/tcache"), "utf8")).toBe(expected);
      else await expect(readFile(join(directory, "destination/tcache"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

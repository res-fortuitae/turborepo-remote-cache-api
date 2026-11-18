import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = new URL("./bin.ts", import.meta.url).pathname;
const cli = Bun.env.TCACHE_TEST_BINARY ? [Bun.env.TCACHE_TEST_BINARY] : [process.execPath, bin];

test.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", stubborn: false, group: true },
  { signal: "SIGTERM", stubborn: false, group: false },
  { signal: "SIGINT", stubborn: true, group: false },
] as const)(
  "exec forwards $signal with one delivery and a grace period",
  async (fixture) => {
    const directory = await mkdtemp(join(tmpdir(), "tcache-exec-signals-"));
    const script = `
    const record = (signal) => console.log(JSON.stringify([signal, Date.now()]));
    let exit;
    process.on("SIGINT", () => {
      record("SIGINT");
      if (!${fixture.stubborn}) exit ??= setTimeout(() => process.exit(130), 300);
    });
    process.on("SIGTERM", () => {
      record("SIGTERM");
      if (!${fixture.stubborn}) exit ??= setTimeout(() => process.exit(143), 300);
    });
    setTimeout(() => process.exit(9), 14_000);
    console.log("ready");
  `;
    try {
      const wrapper = Bun.spawn([...cli, "exec", "--", process.execPath, "-e", script], {
        cwd: directory,
        env: { HOME: directory, PATH: Bun.env.PATH },
        detached: true,
        stdout: "pipe",
        stderr: "ignore",
      });
      try {
        const reader = wrapper.stdout.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
        process.kill(fixture.group ? -wrapper.pid : wrapper.pid, fixture.signal);
        const decoder = new TextDecoder();
        let output = "";
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          output += decoder.decode(next.value, { stream: true });
        }
        output += decoder.decode();
        const code = await wrapper.exited;
        const signals = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as [string, number]);
        expect(signals.map(([signal]) => signal)).toEqual(
          fixture.stubborn ? ["SIGINT", "SIGTERM"] : [fixture.signal],
        );
        if (fixture.stubborn) expect(signals[1]![1] - signals[0]![1]).toBeGreaterThanOrEqual(9_900);
        expect(code).toBe(fixture.stubborn ? 137 : fixture.signal === "SIGTERM" ? 143 : 130);
      } finally {
        wrapper.kill();
        await wrapper.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

const { readFile, rm } = require("node:fs/promises");
const { join, basename } = require("node:path");
const { connect } = require("node:net");

async function main() {
  const directory = process.env.TCACHE_PROBE_DIRECTORY;

  if (!directory || !basename(directory).startsWith("tcache-lifecycle-")) return;

  try {
    const checked = await readFile(join(directory, "checked.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);

    if (checked) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(checked.api)) throw new Error("invalid probe origin");
      let closed = false;

      for (let attempt = 0; attempt < 60 && !closed; attempt++) {
        closed = await new Promise((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port: Number(new URL(checked.api).port) });
          socket.setTimeout(3000);
          socket.once("connect", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("timeout", () => {
            socket.destroy();
            reject(new Error("cleanup probe timed out"));
          });
          socket.once("error", (error) =>
            error.code === "ECONNREFUSED" ? resolve(true) : reject(error),
          );
        });

        if (!closed) await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (!closed) throw new Error("proxy still listening after post");
      console.log("Automatic post-step closed the proxy listener.");
    }
  } finally {
    const upstream = JSON.parse(await readFile(join(directory, "upstream.json"), "utf8"));
    await fetch(upstream.api + "/_probe/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${upstream.secret}` },
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(() => {
  console.error("Proxy post-step cleanup verification failed.");
  process.exitCode = 1;
});

// Isolated runner-lifecycle fixture, never a production issuer/cache implementation.
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const directory = process.argv[2];
const secret = randomUUID();
let exchanges = 0;
let proofs = 0;
const tokens = new Map();

const server = createServer(async (request, response) => {
  if (request.url === "/oidc/exchange") {
    exchanges++;
    const token = `fixture-token-${exchanges}`;
    const expiry = Date.now() + 2500;
    tokens.set(token, expiry);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        api: `http://127.0.0.1:${server.address().port}`,
        team: "org",
        project: "p",
        token,
        scope: "read write",
        expiresAt: new Date(expiry).toISOString(),
      }),
    );

    return;
  }

  if (request.url === "/_probe/stop" && request.headers.authorization === `Bearer ${secret}`) {
    response.end();
    server.close();
    server.closeAllConnections();

    return;
  }

  if (request.url === "/_probe/stats" && request.headers.authorization === `Bearer ${secret}`) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ exchanges, proofs }));

    return;
  }

  const token = request.headers.authorization?.replace(/^DPoP /, "");

  if (!(tokens.get(token) > Date.now()) || !request.headers.dpop) {
    response.writeHead(403);
    response.end();

    return;
  }

  proofs++;

  if (request.method === "PUT") {
    for await (const _chunk of request) {
      /* stream */
    }

    response.writeHead(202);
    response.end();

    return;
  }

  response.setHeader("content-length", "7");
  response.end(request.method === "HEAD" ? undefined : "fixture");
});

server.listen(0, "127.0.0.1", async () => {
  await writeFile(
    join(directory, "upstream.json"),
    JSON.stringify({ api: `http://127.0.0.1:${server.address().port}`, secret }),
    { mode: 0o600, flag: "wx" },
  );
});

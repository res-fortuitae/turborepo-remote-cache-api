import * as Schema from "effect/Schema";
import { mkdir, chmod, writeFile, rename, lstat, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const devicePollLimitMs = 15 * 60 * 1000;
const deviceClock = {
  now: () => performance.now(),
  wait: (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }),
};

export const configDirectory = () => join(homedir(), ".config", "tcache");
export const safeServer = (input: string) => {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use an HTTPS instance origin (HTTP is allowed on loopback).");
  return url.origin;
};
export const saveSession = async (api: string, token: string, fileSession = false) => {
  const directory = configDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe config directory");
  await chmod(directory, 0o700);
  const temporary = join(directory, `session-${crypto.randomUUID()}.tmp`);
  let credential: { api: string; token?: string; keychain?: boolean };
  if (fileSession) {
    credential = { api, token };
  } else {
    try {
      await Bun.secrets.set({ service: "tcache", name: api, value: token, persist: "local" });
      credential = { api, keychain: true };
    } catch {
      console.error("OS credential store unavailable; using a private session file.");
      credential = { api, token };
    }
  }
  await writeFile(temporary, JSON.stringify(credential), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(directory, "session.json"));
};
export const readSession = async (): Promise<{ api: string; token: string } | undefined> => {
  try {
    const path = join(configDirectory(), "session.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error();
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value.api !== "string") throw new Error();
    const api = safeServer(value.api);
    const token =
      value.keychain === true
        ? await Bun.secrets.get({ service: "tcache", name: api })
        : value.token;
    if (typeof token !== "string" || !token) throw new Error();
    return { api, token };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Cannot read private tcache session. Run login again.");
  }
};

/** Protocol polling is bounded by the advertised expiry and handles RFC 8628 backoff. */
export const deviceLogin = async (
  server: string,
  output: (message: string) => void = console.error,
  signal?: AbortSignal,
  fileSession = false,
  clock = deviceClock,
) => {
  const api = safeServer(server);
  const post = (path: string, body: object, timeoutMs = 10_000) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(`${api}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };
  const response = await post("/device/code", { client_id: "tcache", scope: "developer" });
  if (!response.ok) throw new Error("Device login could not start.");
  const code = Schema.decodeUnknownSync(
    Schema.Struct({
      device_code: Schema.String,
      user_code: Schema.String,
      verification_uri: Schema.String,
      expires_in: Schema.Number,
      interval: Schema.Number,
    }),
  )(await response.json());
  if (!Number.isFinite(code.expires_in) || code.expires_in <= 0 || !Number.isFinite(code.interval))
    throw new Error("Device login could not start.");
  const verification = new URL(code.verification_uri);
  if (verification.origin !== api) throw new Error("Invalid verification origin");
  const deadline = clock.now() + Math.min(devicePollLimitMs, code.expires_in * 1000);
  output(
    `Open ${verification.href}\nEnter code: ${code.user_code}\nOnly approve a device in your possession.`,
  );
  let intervalMs = Math.max(5, code.interval) * 1000;
  while (true) {
    const waitMs = Math.min(intervalMs, deadline - clock.now());
    if (waitMs <= 0) break;
    await clock.wait(Math.ceil(waitMs), signal);
    signal?.throwIfAborted();
    const remainingMs = Math.ceil(deadline - clock.now());
    if (remainingMs <= 0) break;
    const result = await post(
      "/device/token",
      {
        client_id: "tcache",
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      Math.min(10_000, remainingMs),
    );
    if (result.status === 429 || result.status >= 500) {
      await result.body?.cancel().catch(() => undefined);
      intervalMs += 5_000;
      continue;
    }
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        access_token: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
      }),
    )(await result.json());
    if (result.ok && typeof value.access_token === "string") {
      await saveSession(api, value.access_token, fileSession);
      output("Signed in. Session saved privately.");
      return;
    }
    if (value.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (value.error === "authorization_pending") continue;
    throw new Error("Device request denied or expired. Run login again.");
  }
  throw new Error("Device request expired. Run login again.");
};

export const removeSession = async () => {
  const session = await readSession();
  const metadata = session
    ? JSON.parse(await readFile(join(configDirectory(), "session.json"), "utf8"))
    : undefined;
  if (session && metadata?.keychain === true) {
    try {
      await Bun.secrets.delete({ service: "tcache", name: session.api });
    } catch {
      /* File fallback has no keychain entry. */
    }
  }
  try {
    await unlink(join(configDirectory(), "session.json"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
};

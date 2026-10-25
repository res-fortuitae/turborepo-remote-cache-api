import { PurgeFilter, PurgeReport } from "@repo/shared";
import { Schema } from "effect";

/** Session-cookie adapter until device login supplies the shared credential store. */
export async function adminPurge(
  args: readonly string[],
  env: { server?: string; cookie?: string },
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const [projectId, ...options] = args;
  const option = (name: string) => options[options.indexOf(name) + 1];
  if (!projectId || !env.server || !env.cookie)
    throw new Error(
      "Set TURBO_API and TCACHE_SESSION_COOKIE; usage: tcache admin purge PROJECT --filter '{...}' | --job ID [--confirm]",
    );
  const base = new URL(env.server);
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
    throw new Error("An HTTPS server is required");
  const job = options.includes("--job") ? option("--job") : undefined;
  if (options.includes("--confirm") && !job)
    throw new Error("Confirm a completed dry run with --job ID --confirm");
  if (options.includes("--job") && !job) throw new Error("Missing job ID");
  const filter = job
    ? undefined
    : Schema.decodeUnknownSync(Schema.fromJsonString(PurgeFilter))(
        options.includes("--filter") ? option("--filter") : "{}",
      );
  const response = await fetcher(
    new URL(
      `/projects/${encodeURIComponent(projectId)}/purges${job ? `/${encodeURIComponent(job)}` : ""}${options.includes("--confirm") ? "/confirm" : ""}`,
      base,
    ),
    {
      method: !job || options.includes("--confirm") ? "POST" : "GET",
      headers: { cookie: env.cookie, origin: base.origin, "content-type": "application/json" },
      ...(filter ? { body: JSON.stringify(filter) } : {}),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(
      `Purge request failed (${response.status}). Check the session, permission and preview state.`,
    );
  return Schema.decodeUnknownSync(PurgeReport)(await response.json());
}

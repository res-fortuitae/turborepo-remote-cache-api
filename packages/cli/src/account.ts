import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Schema } from "effect";
import { readSession, removeSession, safeServer } from "./device.ts";

/** Requests never redirect a session to another origin or print a server error body. */
export const sessionRequest = async (
  path: string,
  method = "GET",
  body?: unknown,
  server?: string,
) => {
  const session = await readSession();
  if (!session || (server && safeServer(server) !== session.api))
    throw new Error("Run tcache login for this instance.");
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
  const response = await fetch(`${session.api}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: `Bearer ${session.token}`,
      origin: session.api,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`Request failed (${response.status}). Check login and permissions.`);
  return response;
};
export const whoami = async () => {
  const response = await sessionRequest("/api/auth/get-session");
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
    }),
  )(await response.json());
  console.log(JSON.stringify(value.user, null, 2));
};
export const logout = async () => {
  // If revocation fails retain the credential so the user can retry.
  if (await readSession()) await sessionRequest("/api/auth/sign-out", "POST", {});
  await removeSession();
  console.error("Signed out. Local session removed.");
};
const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
const Project = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  orgId: Schema.String,
});
const select = async <T extends { id: string; name: string; slug: string }>(
  items: readonly T[],
  hint: string | undefined,
  label: string,
): Promise<T> => {
  if (hint) {
    const selected = items.find((item) => item.id === hint || item.slug === hint);
    if (!selected) throw new Error(`No accessible ${label} matches that ID or slug.`);
    return selected;
  }
  if (items.length === 1) return items[0]!;
  if (!process.stdin.isTTY) throw new Error(`Pass --${label} in non-interactive mode.`);
  if (!items.length) throw new Error(`No accessible ${label}s.`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(items.map((item, i) => `${i + 1}. ${item.name} (${item.slug})`).join("\n"));
    const index = Number(await terminal.question(`Choose ${label}: `)) - 1;
    const selected = items[index];
    if (!selected) throw new Error("Invalid selection");
    return selected;
  } finally {
    terminal.close();
  }
};
export const linkProject = async (options: {
  team?: string;
  project?: string;
  force?: boolean;
  api?: string;
}) => {
  const session = await readSession();
  if (!session) throw new Error("Run tcache login first.");
  const orgs = Schema.decodeUnknownSync(Schema.Array(Organization))(
    await (
      await sessionRequest("/api/auth/organization/list", "GET", undefined, options.api)
    ).json(),
  );
  const org = await select(orgs, options.team, "team");
  let project: typeof Project.Type;
  if (options.project) {
    project = Schema.decodeUnknownSync(Project)(
      await (await sessionRequest(`/projects/${encodeURIComponent(options.project)}`)).json(),
    );
    if (project.orgId !== org.id) throw new Error("Project does not belong to the selected team.");
  } else {
    const items: Array<typeof Project.Type> = [];
    let cursor: string | null = null;
    do {
      const path = `/orgs/${encodeURIComponent(org.id)}/projects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = Schema.decodeUnknownSync(
        Schema.Struct({ items: Schema.Array(Project), nextCursor: Schema.NullOr(Schema.String) }),
      )(await (await sessionRequest(path)).json());
      items.push(...page.items);
      if (items.length > 10000 || (page.nextCursor === cursor && cursor !== null))
        throw new Error("Project listing exceeded its bound. Pass --project ID.");
      cursor = page.nextCursor;
    } while (cursor);
    project = await select(items, undefined, "project");
  }
  const config = {
    api: session.api,
    team: org.id,
    teamSlug: org.slug,
    project: project.id,
    projectSlug: project.slug,
  };
  await writeFile(".turbo-cache.json", JSON.stringify(config, null, 2) + "\n", {
    flag: options.force ? "w" : "wx",
    mode: 0o644,
  });
  console.error(
    `Linked ${org.slug}/${project.slug}. Commit .turbo-cache.json; it contains no credentials.`,
  );
};

export const adminRequest = async (
  kind: string,
  operation: string,
  options: { team: string; project: string; id: string; json: string },
) => {
  const id = encodeURIComponent(options.id);
  const project = encodeURIComponent(options.project);
  const team = encodeURIComponent(options.team);
  const payload: unknown = options.json ? JSON.parse(options.json) : undefined;
  const routes: Record<string, readonly [string, string]> = {
    "projects:list": ["GET", `/orgs/${team}/projects`],
    "projects:create": ["POST", `/orgs/${team}/projects`],
    "projects:get": ["GET", `/projects/${project}`],
    "projects:update": ["PATCH", `/projects/${project}`],
    "projects:delete": ["DELETE", `/projects/${project}`],
    "policies:list": ["GET", `/projects/${project}/trust-policies`],
    "policies:create": ["POST", `/projects/${project}/trust-policies`],
    "policies:update": ["PUT", `/projects/${project}/trust-policies/${id}`],
    "policies:delete": ["DELETE", `/projects/${project}/trust-policies/${id}`],
    "policies:test": ["POST", `/projects/${project}/trust-policies/test`],
    "keys:list": ["POST", "/api/auth/cache-keys/list"],
    "keys:create": ["POST", "/api/auth/cache-keys/create"],
    "keys:revoke": ["POST", "/api/auth/cache-keys/revoke"],
  };
  const route = routes[`${kind}:${operation}`];
  if (!route) throw new Error("Unsupported admin operation");
  if (
    kind === "projects" && ["list", "create"].includes(operation)
      ? !options.team
      : kind !== "keys" && !options.project
  )
    throw new Error("Pass the required --team or --project ID.");
  if (["update", "delete"].includes(operation) && kind === "policies" && !options.id)
    throw new Error("Pass --id.");
  const response = await sessionRequest(route[1], route[0], payload);
  if (response.status !== 204) console.log(JSON.stringify(await response.json(), null, 2));
};

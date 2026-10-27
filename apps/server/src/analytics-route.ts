import { BadRequest, Forbidden, NotFound } from "@repo/api-spec";
import { AnalyticsDrilldowns, AnalyticsQuery } from "@repo/analytics";
import { Auth } from "@repo/auth";
import { Authorization } from "@repo/authz";
import { ProjectRepo } from "@repo/db";
import { Effect } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";

export const analyticsPath =
  /^\/(?:(orgs|projects)\/([^/]+)|instance)\/analytics(\/drilldown)?\/?$/;

const error = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { "cache-control": "no-store" } });

export const analyticsRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;

  if (request.method !== "GET") return yield* error(405, "Method not allowed");
  const url = new URL(request.url, "http://localhost");
  const match = analyticsPath.exec(url.pathname);

  if (!match) return yield* error(404, "Not found");
  const auth = yield* Auth;
  const session = yield* auth.requireFreshSession(new Headers(request.headers));

  if (session.user.banned || session.session.impersonatedBy)
    return yield* new Forbidden({ message: "A live, non-impersonated session is required" });
  const kind = match[1];
  const id = match[2];
  const drilldown = Boolean(match[3]);
  let orgId: string | undefined;
  let projectId: string | undefined;

  if (kind === "projects" && id) {
    const project = yield* (yield* ProjectRepo).locate(id);

    if (!project) return yield* new NotFound({ message: "Project not found" });
    orgId = project.orgId;
    projectId = project.id;
  } else if (kind === "orgs") orgId = id;

  if (orgId)
    yield* (yield* Authorization).require(
      { userId: session.user.id, sessionId: session.session.id },
      "analytics:read",
      { orgId, ...(projectId ? { projectId } : {}) },
    );
  else if (!["auditor", "admin", "owner"].includes(session.user.role ?? "member"))
    return yield* new Forbidden({ message: "Instance analytics role required" });

  if (drilldown && !projectId)
    return yield* new BadRequest({ message: "Drill-down requires a project" });

  const allowed = new Set(
    drilldown ? ["from", "to", "template", "ref", "limit"] : ["from", "to", "granularity"],
  );

  const input: Record<string, string | number> = {};

  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(input, key))
      return yield* new BadRequest({ message: "Unknown or repeated analytics filter" });
    input[key] = key === "limit" ? Number(value) : value;
  }

  if (drilldown)
    return yield* Response.json(
      yield* (yield* AnalyticsDrilldowns).read({ orgId: orgId!, projectId: projectId! }, input),
    );

  return yield* Response.json(
    yield* (yield* AnalyticsQuery).read(
      { ...(orgId ? { orgId } : {}), ...(projectId ? { projectId } : {}) },
      input,
    ),
  );
}).pipe(
  Effect.catchTags({
    BadRequest: (e) => error(400, e.message),
    Forbidden: (e) => error(403, e.message),
    NotFound: (e) => error(404, e.message),
    AuthError: () => error(401, "Authentication failed"),
    Unauthenticated: () => error(401, "A live session is required"),
    AuthzError: (e) => error(e.reason === "unavailable" ? 503 : 403, "Permission denied"),
    AnalyticsError: () => error(503, "Analytics unavailable; retry later"),
  }),
  Effect.map((response) => Response.setHeader(response, "cache-control", "no-store")),
);

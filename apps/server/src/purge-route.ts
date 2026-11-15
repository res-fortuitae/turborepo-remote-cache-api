import { IncidentPurge, PurgeFilter, purgeSummary } from "@repo/artifacts";
import { Auth } from "@repo/auth";
import { Authorization } from "@repo/authz";
import { ProjectRepo } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { BadRequest, Forbidden, NotFound } from "@repo/api-spec";
import { Effect, Schema } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { requireAdminProof } from "./admin-proof.ts";
import { readManagementJson } from "./projects-route.ts";

export const purgePath = /^\/projects\/([^/]+)\/purges(?:\/([\w-]+)(?:\/(confirm))?)?\/?$/;
const error = (status: number, message: string) => Response.json({ message }, { status });
export const purgeRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;
  const path = new URL(request.url, "http://localhost").pathname;
  const match = purgePath.exec(path);
  if (!match?.[1]) return yield* error(404, "Not found");
  const auth = yield* Auth;
  const session = yield* auth.requireFreshSession(new Headers(request.headers));
  if (request.method !== "GET" && request.headers.origin !== (yield* CanonicalOrigin))
    return yield* new Forbidden({ message: "A matching Origin header is required" });
  const repo = yield* ProjectRepo;
  const project = yield* repo.locate(match[1]);
  if (!project) return yield* new NotFound({ message: "Project not found" });
  const authorization = yield* Authorization;
  yield* authorization.require(
    { userId: session.user.id, sessionId: session.session.id },
    "update",
    { orgId: project.orgId, projectId: project.id },
  );
  if (request.method !== "GET") {
    yield* requireAdminProof(project.orgId, session.user, session.session.id);
  }
  const purge = yield* IncidentPurge;
  if (request.method === "GET" && match[2] && !match[3])
    return yield* Response.json(
      purgeSummary(yield* purge.get(project.orgId, project.id, match[2])),
    );
  if (request.method === "POST" && !match[2]) {
    const filter = yield* Schema.decodeUnknownEffect(PurgeFilter)(
      yield* readManagementJson(request),
    ).pipe(Effect.mapError(() => new BadRequest({ message: "Invalid purge filter" })));
    return yield* Response.json(
      purgeSummary(yield* purge.preview(project.orgId, project.id, session.user.id, filter)),
      { status: 202 },
    );
  }
  if (request.method === "POST" && match[2] && match[3])
    return yield* Response.json(
      purgeSummary(yield* purge.confirm(project.orgId, project.id, match[2], session.user.id)),
      { status: 202 },
    );
  return yield* error(405, "Method not allowed");
}).pipe(
  Effect.catchTags({
    Unauthenticated: () => error(401, "A live session is required"),
    AuthError: () => error(401, "Authentication failed"),
    AuthzError: (e) => error(e.reason === "unavailable" ? 503 : 403, "Permission denied"),
    Forbidden: (e) => error(403, e.message),
    NotFound: (e) => error(404, e.message),
    BadRequest: (e) => error(400, e.message),
    PurgeError: (e) => error(e.message.includes("unavailable") ? 503 : 409, e.message),
  }),
  Effect.map((r) => Response.setHeader(r, "cache-control", "no-store")),
);

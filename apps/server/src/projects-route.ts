import {
  BadRequest,
  CreateProjectRequest,
  DeleteProjectRequest,
  Forbidden,
  GrantRequest,
  UpdateProjectRequest,
} from "@repo/api-spec";
import { Auth } from "@repo/auth";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Projects, type ProjectActor } from "@repo/projects";
import { Effect, Layer, Schema, Stream } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const collection = /^\/orgs\/([^/]+)\/projects\/?$/;
const item = /^\/projects\/([^/]+)\/?$/;
const grantsPath = /^\/projects\/([^/]+)\/grants(?:\/(user|team)\/([^/]+))?\/?$/;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const decodeCreate = Schema.decodeUnknownEffect(CreateProjectRequest);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateProjectRequest);
const decodeDelete = Schema.decodeUnknownEffect(DeleteProjectRequest);
const decodeGrant = Schema.decodeUnknownEffect(GrantRequest);

/** Web Request's text/json accessors do not honor Effect's MaxBodySize reference. */
const readJson = Effect.fn("Projects.readJson")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const decoder = new TextDecoder();
  let size = 0;

  const text = yield* Stream.runFoldEffect(
    request.stream,
    () => "",
    (text, chunk) => {
      size += chunk.byteLength;

      return size > 16_384
        ? Effect.fail(new BadRequest({ message: "Project request exceeds 16 KiB" }))
        : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
    },
  ).pipe(Effect.mapError(() => new BadRequest({ message: "Invalid or oversized project body" })));

  return yield* decodeJson(text + decoder.decode()).pipe(
    Effect.mapError(() => new BadRequest({ message: "Invalid JSON body" })),
  );
});

export const isProjectsPath = (path: string) =>
  collection.test(path) || item.test(path) || grantsPath.test(path);

const errorResponse = (status: number, code: string, message: string) =>
  HttpServerResponse.json({ code, message }, { status });

/** Session-authenticated project management; the cache credential API follows in M3. */
export const projectsApi = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://localhost");
  const auth = yield* Auth;
  const session = yield* auth.requireFreshSession(new Headers(request.headers));

  if (request.method !== "GET") {
    const origin = yield* CanonicalOrigin;

    if (request.headers.origin !== origin)
      return yield* new Forbidden({ message: "A matching Origin header is required" });
  }

  const actor: ProjectActor = {
    userId: session.user.id,
    sessionId: session.session.id,
    display: session.user.name,
    requestId: crypto.randomUUID(),
    ip: request.headers["cf-connecting-ip"] ?? "",
    userAgent: request.headers["user-agent"] ?? "",
  };

  const projects = yield* Projects;
  const orgMatch = collection.exec(url.pathname);
  const projectMatch = item.exec(url.pathname);
  const grantMatch = grantsPath.exec(url.pathname);

  const decodeId = (value: string) =>
    Effect.try({
      try: () => decodeURIComponent(value),
      catch: () => new BadRequest({ message: "Invalid identifier" }),
    });

  if (grantMatch?.[1]) {
    const id = yield* decodeId(grantMatch[1]);

    if (!grantMatch[2] && request.method === "GET")
      return yield* HttpServerResponse.json(yield* projects.listGrants(actor, id));

    if (!grantMatch[2] && request.method === "POST") {
      const body = yield* decodeGrant(yield* readJson(request)).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid grant" })),
      );

      return yield* HttpServerResponse.json(yield* projects.addGrant(actor, id, body), {
        status: 201,
      });
    }

    if (
      (grantMatch[2] === "user" || grantMatch[2] === "team") &&
      grantMatch[3] &&
      request.method === "DELETE"
    ) {
      yield* projects.removeGrant(actor, id, grantMatch[2], yield* decodeId(grantMatch[3]));

      return HttpServerResponse.empty({ status: 204 });
    }

    return HttpServerResponse.empty({ status: 405 });
  }

  if (orgMatch?.[1]) {
    const orgId = yield* decodeId(orgMatch[1]);

    if (request.method === "GET") {
      const limit = url.searchParams.get("limit");

      return yield* HttpServerResponse.json(
        yield* projects.list(actor, orgId, {
          limit: limit === null ? undefined : Number(limit),
          cursor: url.searchParams.get("cursor") ?? undefined,
        }),
      );
    }

    if (request.method === "POST") {
      const body = yield* decodeCreate(yield* readJson(request)).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid project" })),
      );

      return yield* HttpServerResponse.json(yield* projects.create(actor, orgId, body), {
        status: 201,
      });
    }

    return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST" } });
  }

  if (projectMatch?.[1]) {
    const id = yield* decodeId(projectMatch[1]);

    if (request.method === "GET")
      return yield* HttpServerResponse.json(yield* projects.get(actor, id));

    if (request.method === "PATCH") {
      const body = yield* decodeUpdate(yield* readJson(request)).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid project update" })),
      );

      return yield* HttpServerResponse.json(yield* projects.update(actor, id, body));
    }

    if (request.method === "DELETE") {
      const body = yield* decodeDelete(yield* readJson(request)).pipe(
        Effect.mapError(() => new BadRequest({ message: "Confirm deletion with the project ID" })),
      );
      yield* projects.delete(actor, id, body.confirmation);
      return HttpServerResponse.empty({ status: 202 });
    }

    return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, PATCH, DELETE" } });
  }

  return yield* errorResponse(404, "not_found", "Not found");
}).pipe(
  Effect.catchTags({
    Unauthenticated: () => errorResponse(401, "unauthorized", "A live session is required"),
    AuthError: (error) =>
      errorResponse(
        error.status >= 500 ? 500 : error.status,
        "authentication_error",
        "Authentication failed",
      ),
    Forbidden: (error) => errorResponse(403, "forbidden", error.message),
    BadRequest: (error) => errorResponse(400, "bad_request", error.message),
    NotFound: (error) => errorResponse(404, "not_found", error.message),
    Conflict: (error) => errorResponse(409, "conflict", error.message),
  }),
);

export const projectsRoute = <E, R>(layer: Layer.Layer<Auth | Projects, E, R>) =>
  projectsApi.pipe(
    Effect.provide(layer),
    Effect.catch((error) =>
      Effect.logError("Project request failed", error).pipe(
        Effect.andThen(errorResponse(500, "internal_error", "Project management is unavailable")),
      ),
    ),
    Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );

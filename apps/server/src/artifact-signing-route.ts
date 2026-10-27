import { Auth, requirePasskeyProof } from "@repo/auth";
import { Authorization, AuthorizationCeilings } from "@repo/authz";
import { ArtifactSigning } from "@repo/credentials";
import { Database, InstanceSettingsRepo, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { readManagementJson } from "./projects-route.ts";

export const signingPath = /^\/projects\/([^/]+)\/signing(?:\/(rotate))?$/;
const decodeInput = Schema.decodeUnknownEffect(Schema.Struct({ required: Schema.Boolean }));
export const artifactSigningRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;
  const match = signingPath.exec(new URL(request.url, "http://localhost").pathname);
  if (!match?.[1]) return Response.empty({ status: 404 });
  if (!["GET", "POST"].includes(request.method)) return Response.empty({ status: 405 });
  const session = yield* (yield* Auth).requireFreshSession(new Headers(request.headers));
  if (session.session.impersonatedBy) return Response.empty({ status: 403 });
  const origin = yield* CanonicalOrigin;
  if (request.method === "POST" && request.headers.origin !== origin)
    return Response.empty({ status: 403 });
  const projectId = yield* Effect.try(() => decodeURIComponent(match[1]!));
  const db = yield* Database;
  const [project] = yield* db.query("Signing.project", (q) =>
    q.select().from(schema.project).where(eq(schema.project.id, projectId)),
  );
  if (!project) return Response.empty({ status: 404 });
  const authorization = yield* Authorization;
  yield* authorization.require(
    { userId: session.user.id, sessionId: session.session.id },
    "update",
    { orgId: project.orgId, projectId },
  );
  const signing = yield* ArtifactSigning;
  const policy = yield* (yield* InstanceSettingsRepo).policy(
    project.orgId,
    yield* AuthorizationCeilings,
  );
  const event = {
    scope: "org" as const,
    orgId: project.orgId,
    projectId,
    actor: { type: "user" as const, id: session.user.id, display: session.user.name },
    action: "artifact.signing.configure",
    target: { type: "project", id: projectId },
    outcome: "allow" as const,
    ip: request.headers["cf-connecting-ip"] ?? "",
    userAgent: request.headers["user-agent"] ?? "",
    requestId: crypto.randomUUID(),
    metadata: {},
  };
  if (request.method === "POST") {
    if (policy.requirePasskeyForAdmins && ["owner", "admin"].includes(session.user.role ?? "")) {
      const proof = yield* Effect.tryPromise(() =>
        requirePasskeyProof(db.drizzle, session.session.id, session.user.id),
      ).pipe(Effect.result);
      if (proof._tag === "Failure")
        return yield* Response.json(
          { message: "Verify your administrator passkey before changing signing settings" },
          { status: 403 },
        );
    }
    if (match[2]) yield* signing.rotate(project.orgId, projectId, event);
    else {
      const input = yield* decodeInput(yield* readManagementJson(request));
      const status = yield* signing.status(projectId);
      if (input.required && status.keys.length === 0)
        return yield* Response.json(
          { message: "Generate a signing key before requiring signatures" },
          { status: 409 },
        );
      yield* signing.configure(projectId, input.required, event);
    }
  }
  return yield* Response.json({
    ...(yield* signing.status(projectId)),
    instanceRequired: policy.requireArtifactSigning,
  });
}).pipe(
  Effect.catchTags({
    BadRequest: () => Response.json({ message: "Invalid signing settings" }, { status: 400 }),
    SchemaError: () => Response.json({ message: "Invalid signing settings" }, { status: 400 }),
    Unauthenticated: () => Response.json({ message: "Sign in required" }, { status: 401 }),
    AuthzError: () => Response.json({ message: "Project admin access required" }, { status: 403 }),
    ArtifactSigningError: () =>
      Response.json(
        {
          message:
            "Signing operation unavailable; rotation is blocked while a previous key is in its 24-hour overlap",
        },
        { status: 409 },
      ),
  }),
  Effect.catch(() => Response.json({ message: "Signing settings unavailable" }, { status: 503 })),
  Effect.map((response) => Response.setHeader(response, "cache-control", "no-store")),
);

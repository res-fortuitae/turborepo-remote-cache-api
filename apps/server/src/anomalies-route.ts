import { Auth } from "@repo/auth";
import { Authorization } from "@repo/authz";
import { Database, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Schema } from "effect";
import { desc, eq } from "drizzle-orm";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { Anomalies } from "@repo/artifacts";
import { readManagementJson } from "./projects-route.ts";
import { requireAdminProof } from "./admin-proof.ts";
export const anomalyPath = /^\/projects\/([^/]+)\/anomalies$/;
const Settings = Schema.Struct({
  enabled: Schema.Boolean,
  readOnlyOnAlert: Schema.Boolean,
  revokeOnAlert: Schema.Boolean,
  minHourlyWrites: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 1_000_000 })),
  volumeMultiplier: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 })),
  maxExchangeIPs: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 })),
  resume: Schema.Boolean,
});
export const anomaliesRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;
  const match = anomalyPath.exec(new URL(request.url, "http://localhost").pathname);
  if (!match?.[1]) return Response.empty({ status: 404 });
  if (!["GET", "POST"].includes(request.method)) return Response.empty({ status: 405 });
  const session = yield* (yield* Auth).requireFreshSession(new Headers(request.headers));
  if (session.session.impersonatedBy) return Response.empty({ status: 403 });
  if (request.method === "POST" && request.headers.origin !== (yield* CanonicalOrigin))
    return Response.empty({ status: 403 });
  const projectId = yield* Effect.try(() => decodeURIComponent(match[1]!));
  const db = yield* Database;
  const [project] = yield* db.query("Anomaly.project", (q) =>
    q.select().from(schema.project).where(eq(schema.project.id, projectId)),
  );
  if (!project) return Response.empty({ status: 404 });
  yield* (yield* Authorization).require(
    { userId: session.user.id, sessionId: session.session.id },
    "update",
    { orgId: project.orgId, projectId },
  );
  const anomalies = yield* Anomalies;
  if (request.method === "POST") {
    const input = yield* Schema.decodeUnknownEffect(Settings)(yield* readManagementJson(request));
    yield* requireAdminProof(project.orgId, session.user, session.session.id);
    const { resume, ...config } = input;
    yield* anomalies.configure(
      projectId,
      config,
      {
        scope: "org",
        orgId: project.orgId,
        projectId,
        actor: { type: "user", id: session.user.id, display: session.user.name },
        action: "security.anomaly.configure",
        target: { type: "project", id: projectId },
        outcome: "allow",
        ip: request.headers["cf-connecting-ip"] ?? "",
        userAgent: request.headers["user-agent"] ?? "",
        requestId: crypto.randomUUID(),
        metadata: { ...input },
      },
      resume,
    );
  }
  const incidents = yield* db.query("Anomaly.incidents", (q) =>
    q
      .select()
      .from(schema.anomalyIncident)
      .where(eq(schema.anomalyIncident.projectId, projectId))
      .orderBy(desc(schema.anomalyIncident.createdAt))
      .limit(100),
  );
  return yield* Response.json({
    config: yield* anomalies.config(projectId),
    blocked: yield* anomalies.blocked(projectId),
    incidents,
  });
}).pipe(
  Effect.catchTags({
    Unauthenticated: () => Response.json({ message: "Sign in required" }, { status: 401 }),
    Forbidden: () =>
      Response.json({ message: "Verify an administrator passkey first" }, { status: 403 }),
    AuthzError: () => Response.json({ message: "Administrator access required" }, { status: 403 }),
    SchemaError: () => Response.json({ message: "Invalid anomaly settings" }, { status: 400 }),
    BadRequest: () => Response.json({ message: "Invalid anomaly settings" }, { status: 400 }),
  }),
  Effect.catch(() => Response.json({ message: "Anomaly settings unavailable" }, { status: 503 })),
  Effect.map((response) => Response.setHeader(response, "cache-control", "no-store")),
);

import { Quotas } from "@repo/artifacts";
import { QuotaSettings } from "@repo/api-spec";
import { Auth, requirePasskeyProof } from "@repo/auth";
import { Authorization } from "@repo/authz";
import { Database, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Schema } from "effect";
import { and, desc, eq, sql } from "drizzle-orm";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { readManagementJson } from "./projects-route.ts";
export const quotaPath = /^\/(projects|orgs)\/([^/]+)\/quotas$/;
const decodeSettings = Schema.decodeUnknownEffect(QuotaSettings);
export const quotasRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;
  const match = quotaPath.exec(new URL(request.url, "http://localhost").pathname);
  if (!match?.[1] || !match[2]) return Response.empty({ status: 404 });
  if (!["GET", "POST"].includes(request.method)) return Response.empty({ status: 405 });
  const session = yield* (yield* Auth).requireFreshSession(new Headers(request.headers));
  if (session.session.impersonatedBy) return Response.empty({ status: 403 });
  if (request.method === "POST" && request.headers.origin !== (yield* CanonicalOrigin))
    return Response.empty({ status: 403 });
  const id = yield* Effect.try(() => decodeURIComponent(match[2]!));
  const db = yield* Database;
  const [project] =
    match[1] === "projects"
      ? yield* db.query("Quota.project", (q) =>
          q.select().from(schema.project).where(eq(schema.project.id, id)),
        )
      : [];
  if (match[1] === "projects" && !project) return Response.empty({ status: 404 });
  const orgId = project?.orgId ?? id,
    projectId = project?.id ?? "";
  yield* (yield* Authorization).require(
    { userId: session.user.id, sessionId: session.session.id },
    "update",
    { orgId, ...(projectId ? { projectId } : {}) },
  );
  const quotas = yield* Quotas;
  if (request.method === "POST") {
    const input = yield* decodeSettings(yield* readManagementJson(request));
    const current = yield* quotas.config({ orgId, projectId });
    if (
      input.storageBytes !== null &&
      input.storageBytes > (projectId ? current.org.storageBytes : current.ceilingBytes)
    )
      return yield* Response.json(
        { message: "Storage quota exceeds the effective organization ceiling" },
        { status: 400 },
      );
    // The existing authorization policy controls fresh administrator proof.
    const [settings] = yield* db.query("Quota.instancePolicy", (q) =>
      q.select().from(schema.instanceSettings),
    );
    if (
      settings?.settings.requirePasskeyForAdmins === true &&
      ["owner", "admin"].includes(session.user.role ?? "")
    ) {
      const proof = yield* Effect.tryPromise(() =>
        requirePasskeyProof(db.drizzle, session.session.id, session.user.id),
      ).pipe(Effect.result);
      if (proof._tag === "Failure")
        return yield* Response.json(
          { message: "Verify an administrator passkey first" },
          { status: 403 },
        );
    }
    yield* quotas.configure({ orgId, projectId }, input, {
      scope: "org",
      orgId,
      ...(projectId ? { projectId } : {}),
      actor: { type: "user", id: session.user.id, display: session.user.name },
      action: "quota.configure",
      target: { type: projectId ? "project" : "org", id: projectId || orgId },
      outcome: "allow",
      ip: request.headers["cf-connecting-ip"] ?? "",
      userAgent: request.headers["user-agent"] ?? "",
      requestId: crypto.randomUUID(),
      metadata: {},
    });
  }
  const status = yield* quotas.status({ orgId, projectId });
  const notifications = yield* db.query("Quota.notifications", (q) =>
    q
      .select()
      .from(schema.notification)
      .where(
        and(eq(schema.notification.userId, session.user.id), eq(schema.notification.kind, "quota")),
      )
      .orderBy(desc(schema.notification.createdAt))
      .limit(100),
  );
  return yield* Response.json({
    ...status,
    notifications: notifications.filter((item) => item.id.includes(`:${orgId}:`)),
  });
}).pipe(
  Effect.catchTags({
    Unauthenticated: () => Response.json({ message: "Sign in required" }, { status: 401 }),
    AuthzError: () => Response.json({ message: "Administrator access required" }, { status: 403 }),
    SchemaError: () => Response.json({ message: "Invalid quota settings" }, { status: 400 }),
    BadRequest: () => Response.json({ message: "Invalid quota settings" }, { status: 400 }),
  }),
  Effect.catch(() => Response.json({ message: "Quota settings unavailable" }, { status: 503 })),
  Effect.map((response) => Response.setHeader(response, "cache-control", "no-store")),
);

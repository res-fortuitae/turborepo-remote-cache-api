import { AuditFilters, BadRequest, Forbidden } from "@repo/api-spec";
import { AuditLog, AuditReader, validateAuditSelection } from "@repo/audit";
import { Auth } from "@repo/auth";
import { Authorization } from "@repo/authz";
import { Effect, Schema, Stream } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";

export const auditPath = /^\/(?:orgs\/([^/]+)|instance)\/audit(?:\/export\.(csv|jsonl))?\/?$/;
const decodeFilters = Schema.decodeUnknownEffect(AuditFilters);
const error = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { "cache-control": "no-store" } });
const columns = [
  "id",
  "ts",
  "scope",
  "orgId",
  "projectId",
  "actor",
  "action",
  "target",
  "outcome",
  "reason",
  "ip",
  "userAgent",
  "requestId",
  "metadata",
  "prevHash",
  "hash",
] as const;
// Prefix formula characters even inside quoted fields; spreadsheet parsers still execute quoted formulas.
const csvCell = (value: unknown) => {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return `"${(/^[=+\-@\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
};
export const auditRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest;
  if (request.method !== "GET") return yield* error(405, "Method not allowed");
  const url = new URL(request.url, "http://localhost");
  const match = auditPath.exec(url.pathname);
  if (!match) return yield* error(404, "Not found");
  const orgId = match[1];
  const format = match[2];
  const auth = yield* Auth;
  const session = yield* auth.requireFreshSession(new Headers(request.headers));
  if (session.user.banned || session.session.impersonatedBy)
    return yield* new Forbidden({ message: "A live, non-impersonated session is required" });
  if (orgId) {
    const authorization = yield* Authorization;
    yield* authorization.require(
      { userId: session.user.id, sessionId: session.session.id },
      format ? "audit:export" : "audit:read",
      { orgId },
    );
  } else if (!["auditor", "admin", "owner"].includes(session.user.role ?? "member"))
    return yield* new Forbidden({ message: "Instance audit role required" });
  const allowed = new Set([
    "from",
    "to",
    "actor",
    "action",
    "target",
    "outcome",
    ...(format ? [] : ["cursor", "limit"]),
  ]);
  const input: Record<string, string | number> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || key in input)
      return yield* new BadRequest({ message: "Unknown or repeated audit filter" });
    input[key] = key === "limit" ? Number(value) : value;
  }
  const reader = yield* AuditReader;
  if (!format) return yield* Response.json(yield* reader.page(orgId, input));
  const filters = yield* decodeFilters(input).pipe(
    Effect.mapError(() => new BadRequest({ message: "Invalid export filters" })),
  );
  yield* validateAuditSelection(orgId, filters);
  // Fetch the first page before sending headers; history failures produce a 503, never a partial successful response.
  const first = yield* reader.page(orgId, { ...filters, limit: 100 });
  const audit = yield* AuditLog;
  yield* audit.commit(
    {
      scope: orgId ? "org" : "instance",
      ...(orgId ? { orgId } : {}),
      actor: { type: "user", id: session.user.id, display: session.user.name },
      action: "audit.export",
      target: { type: "audit", id: orgId ?? "instance" },
      outcome: "allow",
      ip: request.headers["cf-connecting-ip"] ?? "",
      userAgent: request.headers["user-agent"] ?? "",
      requestId: crypto.randomUUID(),
      metadata: { from: filters.from, to: filters.to, format },
    },
    () => [],
  );
  const remaining = first.nextCursor
    ? reader.export(orgId, { ...filters, cursor: first.nextCursor })
    : Stream.empty;
  const events = Stream.concat(Stream.fromIterable(first.items), remaining);
  const encoder = new TextEncoder();
  const lines = Stream.map(events, (event) =>
    encoder.encode(
      format === "jsonl"
        ? JSON.stringify(event) + "\n"
        : columns.map((key) => csvCell(event[key])).join(",") + "\r\n",
    ),
  );
  const body =
    format === "csv"
      ? Stream.concat(Stream.make(encoder.encode(columns.join(",") + "\r\n")), lines)
      : lines;
  return Response.stream(body, {
    contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
    headers: {
      "content-disposition": `attachment; filename="audit.${format}"`,
      "cache-control": "no-store",
    },
  });
}).pipe(
  Effect.catchTags({
    BadRequest: (e) => error(400, e.message),
    Forbidden: (e) => error(403, e.message),
    AuthError: () => error(401, "Authentication failed"),
    Unauthenticated: () => error(401, "A live session is required"),
    AuthzError: (e) => error(e.reason === "unavailable" ? 503 : 403, "Permission denied"),
  }),
  Effect.map((response) => Response.setHeader(response, "cache-control", "no-store")),
);

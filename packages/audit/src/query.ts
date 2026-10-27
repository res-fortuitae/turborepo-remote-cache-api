import { AuditEvent, AuditQuery, BadRequest, Timestamp, Ulid } from "@repo/api-spec";
import { Database, schema } from "@repo/db";
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";

export class AuditQueryError extends Schema.TaggedError<AuditQueryError>()("AuditQueryError", {
  cause: Schema.Unknown,
}) {}
type Query = typeof AuditQuery.Type;
export type AuditSelection = {
  readonly orgId?: string;
  readonly query: Query;
  readonly before?: { readonly ts: string; readonly id: string };
};
export class AuditHistory extends Context.Service<
  AuditHistory,
  {
    readonly read: (
      selection: AuditSelection,
      limit: number,
    ) => Effect.Effect<readonly AuditEvent[], AuditQueryError>;
  }
>()("@repo/audit/AuditHistory") {}
export const AuditHistoryDisabled = Layer.succeed(AuditHistory, { read: () => Effect.succeed([]) });
const decodeQuery = Schema.decodeUnknownEffect(AuditQuery);
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(AuditEvent));
const Cursor = Schema.Struct({ ts: Timestamp, id: Ulid, filter: Schema.String });
const decodeCursor = Schema.decodeUnknownSync(Cursor);
const identifier = /^[A-Za-z0-9_:-]{1,128}$/;
const action = /^[A-Za-z0-9_.:-]{1,128}$/;
const bad = () => new BadRequest({ message: "Invalid audit filters or cursor" });

export const validateAuditSelection = Effect.fn(function* (
  orgId: string | undefined,
  input: unknown,
) {
  const query = yield* decodeQuery(input).pipe(Effect.mapError(bad));
  if (
    Date.parse(query.from) >= Date.parse(query.to) ||
    (orgId !== undefined && !identifier.test(orgId)) ||
    (query.actor !== undefined && !identifier.test(query.actor)) ||
    (query.target !== undefined && !identifier.test(query.target)) ||
    (query.action !== undefined && !action.test(query.action))
  )
    return yield* bad();
  const filter = JSON.stringify([
    orgId ?? null,
    query.from,
    query.to,
    query.actor ?? null,
    query.action ?? null,
    query.target ?? null,
    query.outcome ?? null,
  ]);
  let before: AuditSelection["before"];
  if (query.cursor !== undefined) {
    const cursor = yield* Effect.try({
      try: () => decodeCursor(JSON.parse(atob(query.cursor!))),
      catch: bad,
    });
    if (cursor.filter !== filter) return yield* bad();
    before = { ts: cursor.ts, id: cursor.id };
  }
  return { selection: { orgId, query, before } satisfies AuditSelection, filter };
});

/** Values are strictly validated; identifiers, projections, operators and table names are never user supplied. */
export const auditHistorySql = (selection: AuditSelection, limit: number) => {
  const { query, orgId, before } = selection;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 101 ||
    !identifier.test(orgId ?? "instance") ||
    !action.test(query.action ?? "any") ||
    !identifier.test(query.actor ?? "any") ||
    !identifier.test(query.target ?? "any")
  )
    throw bad();
  // This function also validates direct callers, independently of the route/service boundary.
  Schema.decodeUnknownSync(AuditQuery)(query);
  const conditions = [`ts >= '${query.from}'`, `ts < '${query.to}'`];
  if (orgId !== undefined) conditions.push(`"orgId" = '${orgId}'`);
  if (query.actor !== undefined) conditions.push(`actor.id = '${query.actor}'`);
  if (query.action !== undefined) conditions.push(`action = '${query.action}'`);
  if (query.target !== undefined) conditions.push(`target.id = '${query.target}'`);
  if (query.outcome !== undefined) conditions.push(`outcome = '${query.outcome}'`);
  if (before) {
    Schema.decodeUnknownSync(Cursor)({ ...before, filter: "" });
    conditions.push(`(ts < '${before.ts}' OR (ts = '${before.ts}' AND id < '${before.id}'))`);
  }
  return `SELECT id, ts, "schemaVersion", scope, "orgId", "projectId", actor, action, target, outcome, reason, ip, "userAgent", "requestId", metadata, "prevHash", hash FROM audit.audit_log WHERE ${conditions.join(" AND ")} QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = 1 ORDER BY ts DESC, id DESC LIMIT ${limit}`;
};

const compare = (a: AuditEvent, b: AuditEvent) =>
  Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
export class AuditReader extends Context.Service<
  AuditReader,
  {
    readonly page: (
      orgId: string | undefined,
      query: unknown,
    ) => Effect.Effect<
      { items: readonly AuditEvent[]; nextCursor: string | null },
      BadRequest | AuditQueryError
    >;
    readonly export: (
      orgId: string | undefined,
      query: unknown,
    ) => Stream.Stream<AuditEvent, BadRequest | AuditQueryError>;
  }
>()("@repo/audit/AuditReader") {}

export const AuditReaderLive = Layer.effect(
  AuditReader,
  Effect.gen(function* () {
    const database = yield* Database;
    const history = yield* AuditHistory;
    const page = Effect.fn("AuditReader.page")(function* (
      orgId: string | undefined,
      input: unknown,
    ) {
      const { selection, filter } = yield* validateAuditSelection(orgId, input);
      const { query, before } = selection;
      const limit = query.limit ?? 50;
      const rows = yield* database
        .query("AuditReader.page", (db) =>
          db
            .select({ payload: schema.auditEvent.payload })
            .from(schema.auditEvent)
            .where(
              and(
                orgId === undefined ? undefined : eq(schema.auditEvent.orgId, orgId),
                gte(schema.auditEvent.ts, Date.parse(query.from)),
                lt(schema.auditEvent.ts, Date.parse(query.to)),
                query.actor === undefined
                  ? undefined
                  : sql`json_extract(${schema.auditEvent.payload}, '$.actor.id') = ${query.actor}`,
                query.action === undefined
                  ? undefined
                  : sql`json_extract(${schema.auditEvent.payload}, '$.action') = ${query.action}`,
                query.target === undefined
                  ? undefined
                  : sql`json_extract(${schema.auditEvent.payload}, '$.target.id') = ${query.target}`,
                query.outcome === undefined
                  ? undefined
                  : sql`json_extract(${schema.auditEvent.payload}, '$.outcome') = ${query.outcome}`,
                before === undefined
                  ? undefined
                  : or(
                      lt(schema.auditEvent.ts, Date.parse(before.ts)),
                      and(
                        eq(schema.auditEvent.ts, Date.parse(before.ts)),
                        lt(schema.auditEvent.id, before.id),
                      ),
                    ),
              ),
            )
            .orderBy(desc(schema.auditEvent.ts), desc(schema.auditEvent.id))
            .limit(limit + 1),
        )
        .pipe(Effect.mapError((cause) => new AuditQueryError({ cause })));
      const local = yield* decodeEvents(rows.map((row) => row.payload)).pipe(
        Effect.mapError((cause) => new AuditQueryError({ cause })),
      );
      const remote = yield* history.read(selection, limit + 1);
      // Defense in depth: validate remote rows, scope and filtering before merging either source.
      const validated = yield* decodeEvents(remote).pipe(
        Effect.mapError((cause) => new AuditQueryError({ cause })),
      );
      const matches = (event: AuditEvent) =>
        (orgId === undefined || event.orgId === orgId) &&
        Date.parse(event.ts) >= Date.parse(query.from) &&
        Date.parse(event.ts) < Date.parse(query.to) &&
        (query.actor === undefined || event.actor.id === query.actor) &&
        (query.action === undefined || event.action === query.action) &&
        (query.target === undefined || event.target.id === query.target) &&
        (query.outcome === undefined || event.outcome === query.outcome) &&
        (before === undefined ||
          Date.parse(event.ts) < Date.parse(before.ts) ||
          (event.ts === before.ts && event.id < before.id));
      if (!validated.every(matches))
        return yield* new AuditQueryError({ cause: "History response violated query constraints" });
      const merged = [
        ...new Map([...validated, ...local].map((event) => [event.id, event])).values(),
      ].sort(compare);
      const items = merged.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          merged.length > limit && last
            ? btoa(JSON.stringify({ ts: last.ts, id: last.id, filter }))
            : null,
      };
    });
    return {
      page,
      export: (orgId, input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { selection } = yield* validateAuditSelection(orgId, input);
            return Stream.paginate<string | undefined, AuditEvent, BadRequest | AuditQueryError>(
              selection.query.cursor,
              (cursor) =>
                page(orgId, { ...selection.query, limit: 100, cursor }).pipe(
                  Effect.map(
                    (result) => [result.items, Option.fromNullishOr(result.nextCursor)] as const,
                  ),
                ),
            );
          }),
        ),
    };
  }),
);

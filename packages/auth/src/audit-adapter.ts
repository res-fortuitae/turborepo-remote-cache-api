import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import { type AuditInput, type AuditLogService } from "@repo/audit";
import { schema, type DatabaseDrizzle } from "@repo/db";
import { eq, lt } from "drizzle-orm";
import { Effect } from "effect";
import { APIError } from "better-auth/api";

const models = new Set([
  "user",
  "session",
  "account",
  "organization",
  "member",
  "invitation",
  "team",
  "teamMember",
  "organizationRole",
  "apikey",
  "passkey",
  "deviceCode",
]);
type Row = Record<string, unknown>;
type Intent = typeof schema.authAuditIntent.$inferSelect;

// Only hashes of changed values are retained; tokens, email addresses and credentials never enter metadata.
const digest = async (data: Row, fields: readonly string[]) => {
  const json = JSON.stringify(fields.map((field) => [field, data[field] ?? null]));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** Covers plugin writes too: plugin organization hooks do not cover dynamic roles or admin mutations. */
export const auditedAdapter = (
  adapter: DBAdapter,
  db: DatabaseDrizzle,
  audit?: AuditLogService,
): DBAdapter => {
  const required = () => {
    if (!audit) throw new APIError("SERVICE_UNAVAILABLE", { message: "Audit unavailable" });
    return audit;
  };
  const begin = async (model: string, operation: string, row: Row, values: Row) => {
    const id = crypto.randomUUID();
    const context = tryGetCurrentAuthEndpointContext();
    const user = context?.context.session?.user;
    let orgId =
      typeof row.organizationId === "string"
        ? row.organizationId
        : model === "organization"
          ? String(row.id)
          : undefined;
    if (!orgId && model === "apikey" && typeof row.referenceId === "string")
      orgId = row.referenceId;
    if (!orgId && typeof row.teamId === "string") {
      const [team] = await db.select().from(schema.team).where(eq(schema.team.id, row.teamId));
      orgId = team?.organizationId;
    }
    const input: AuditInput = {
      scope: orgId ? "org" : "instance",
      ...(orgId ? { orgId } : {}),
      actor: user
        ? { type: "user", id: user.id, display: user.name }
        : { type: "system", id: "better-auth", display: "Better Auth" },
      action: `auth.${model}.${operation}`,
      target: { type: model, id: String(row.id) },
      outcome: "allow",
      ip: context?.headers?.get("cf-connecting-ip") ?? "",
      userAgent: context?.headers?.get("user-agent") ?? "",
      requestId: context?.headers?.get("cf-ray") ?? id,
      metadata: { intentId: id, status: "pending", path: context?.path ?? "internal" },
    };
    const fields = Object.keys(values).sort();
    const intent = {
      id,
      createdAt: Date.now(),
      model,
      targetId: String(row.id),
      operation,
      fields,
      digest: operation === "delete" ? null : await digest(values, fields),
      event: JSON.stringify(input),
    };
    await Effect.runPromise(
      required().commit(input, (db) => [db.insert(schema.authAuditIntent).values(intent)]),
    );
    return intent;
  };
  const finish = async (intent: Intent, committed: boolean, reconciled = false) => {
    // Resolution and removal of pending state are atomic; concurrent reconcilers cannot append twice.
    const input = JSON.parse(intent.event) as AuditInput;
    await Effect.runPromise(
      required().commit(
        {
          ...input,
          outcome: committed ? "allow" : "error",
          metadata: { ...input.metadata, status: committed ? "committed" : "aborted", reconciled },
        },
        (db) => [
          db.insert(schema.authAuditResolution).values({ id: intent.id }),
          db.delete(schema.authAuditIntent).where(eq(schema.authAuditIntent.id, intent.id)),
        ],
      ),
    );
  };
  const resolve = async (intent: Intent) => {
    const row = await adapter.findOne<Row>({
      model: intent.model,
      where: [{ field: "id", value: intent.targetId }],
    });
    return intent.operation === "delete"
      ? row === null
      : row !== null && (await digest(row, intent.fields)) === intent.digest;
  };
  const mutate = async <A>(
    model: string,
    operation: string,
    rows: Row[],
    values: Row,
    run: () => Promise<A>,
  ) => {
    if (!models.has(model)) return run();
    if (
      model === "session" &&
      operation === "update" &&
      !Object.keys(values).some((field) => ["userId", "impersonatedBy", "token"].includes(field))
    )
      return run();
    const intents = [];
    for (const row of rows) intents.push(await begin(model, operation, row, values));
    // On failure leave the intents for state-based reconciliation, including partially applied bulk writes.
    const result = await run();
    for (const intent of intents) await finish(intent, await resolve(intent));
    return result;
  };
  const snapshots = async (data: Parameters<DBAdapter["deleteMany"]>[0], single = false) => {
    if (!models.has(data.model)) return [];
    const rows = await adapter.findMany<Row>({ ...data, limit: single ? 1 : 1001 });
    if (rows.length > 1000)
      throw new APIError("BAD_REQUEST", { message: "Audit mutation exceeds 1000 rows" });
    return rows;
  };
  const wrapped: DBAdapter = {
    ...adapter,
    // D1 has no transactions; preserve this wrapper inside Better Auth's sequential transaction callback.
    transaction: (callback) => callback(wrapped),
    create: async (data) => {
      if (!models.has(data.model)) return adapter.create(data);
      const row = {
        ...data.data,
        id: typeof data.data.id === "string" ? data.data.id : crypto.randomUUID(),
      };
      return mutate(data.model, "create", [row], { id: row.id }, () =>
        adapter.create({ ...data, data: row, forceAllowId: true }),
      );
    },
    update: async (data) =>
      mutate(data.model, "update", await snapshots(data, true), data.update, () =>
        adapter.update(data),
      ),
    updateMany: async (data) =>
      mutate(data.model, "update", await snapshots(data), data.update, () =>
        adapter.updateMany(data),
      ),
    delete: async (data) =>
      mutate(data.model, "delete", await snapshots(data, true), {}, () => adapter.delete(data)),
    deleteMany: async (data) =>
      mutate(data.model, "delete", await snapshots(data), {}, () => adapter.deleteMany(data)),
  };
  return wrapped;
};

/** Old intents are resolved by actual database state, never by whether the HTTP request succeeded. */
export const reconcileAuthAudit = async (
  adapter: Pick<DBAdapter, "findOne">,
  db: DatabaseDrizzle,
  audit: AuditLogService,
  now = Date.now(),
) => {
  const intents = await db
    .select()
    .from(schema.authAuditIntent)
    .where(lt(schema.authAuditIntent.createdAt, now - 300_000))
    .limit(100);
  for (const intent of intents) {
    const row = await adapter.findOne<Row>({
      model: intent.model,
      where: [{ field: "id", value: intent.targetId }],
    });
    const committed =
      intent.operation === "delete"
        ? row === null
        : row !== null && (await digest(row, intent.fields)) === intent.digest;
    const input = JSON.parse(intent.event) as AuditInput;
    await Effect.runPromise(
      audit.commit(
        {
          ...input,
          outcome: committed ? "allow" : "error",
          metadata: {
            ...input.metadata,
            status: committed ? "committed" : "aborted",
            reconciled: true,
          },
        },
        (db) => [
          db.insert(schema.authAuditResolution).values({ id: intent.id }),
          db.delete(schema.authAuditIntent).where(eq(schema.authAuditIntent.id, intent.id)),
        ],
      ),
    );
  }
  return intents.length;
};

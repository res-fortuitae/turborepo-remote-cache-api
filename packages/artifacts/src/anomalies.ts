import { AuditLog, type AuditInput } from "@repo/audit";
import { CoordinatorClient } from "@repo/coordinator";
import { Database, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import type { ExchangeIdentity } from "@repo/credentials";
import { and, eq, lt, desc, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Schema } from "effect";

export class AnomalyDeliveryError extends Schema.TaggedError<AnomalyDeliveryError>()(
  "AnomalyDeliveryError",
  {},
) {}
export class AnomalyAlerts extends Context.Service<
  AnomalyAlerts,
  {
    readonly notify: (alert: {
      readonly id: string;
      readonly userId: string;
      readonly to: string;
      readonly kind: "anomaly";
      readonly detail: string;
      readonly consoleURL: string;
    }) => Effect.Effect<void, AnomalyDeliveryError>;
  }
>()("@repo/artifacts/AnomalyAlerts") {}

const HOUR = 3_600_000;
const defaults = {
  enabled: true,
  readOnlyOnAlert: false,
  revokeOnAlert: false,
  minHourlyWrites: 100,
  volumeMultiplier: 5,
  maxExchangeIPs: 20,
};
const makeAnomalies = Effect.gen(function* () {
  const db = yield* Database,
    audit = yield* AuditLog,
    coordinator = yield* CoordinatorClient,
    alerts = yield* AnomalyAlerts,
    origin = yield* CanonicalOrigin;
  const config = (projectId: string) =>
    db
      .query("Anomaly.config", (q) =>
        q.select().from(schema.anomalyConfig).where(eq(schema.anomalyConfig.projectId, projectId)),
      )
      .pipe(Effect.map((rows) => rows[0] ?? { projectId, ...defaults }));
  const blocked = (projectId: string) =>
    db
      .query("Anomaly.fence", (q) =>
        q.select().from(schema.anomalyState).where(eq(schema.anomalyState.projectId, projectId)),
      )
      .pipe(
        Effect.map((rows) => rows[0]?.readOnly === true || rows[0]?.revocationPending === true),
      );
  const incident = Effect.fn("Anomalies.incident")(function* (
    orgId: string,
    projectId: string,
    code: string,
    detail: string,
  ) {
    const settings = yield* config(projectId);
    if (!settings.enabled) return;
    const now = yield* Clock.currentTimeMillis;
    // One incident per signal/project/hour. The audit transaction serializes concurrent inserts.
    const id = `anomaly:${projectId}:${Math.floor(now / HOUR)}:${code}`;
    const [existing] = yield* db.query("Anomaly.deduplicate", (q) =>
      q.select().from(schema.anomalyIncident).where(eq(schema.anomalyIncident.id, id)),
    );
    if (existing) return;
    yield* audit.commit(
      {
        scope: "org",
        orgId,
        projectId,
        actor: { type: "system", id: "anomaly-detector", display: "Anomaly detector" },
        action: "security.anomaly",
        target: { type: "project", id: projectId },
        outcome: "allow",
        ip: "",
        userAgent: "",
        requestId: id,
        metadata: { code, detail },
        reason: code,
      },
      (q) => [
        q
          .insert(schema.anomalyIncident)
          .values({ id, orgId, projectId, code, detail, createdAt: now })
          .onConflictDoNothing(),
        q
          .insert(schema.anomalyState)
          .values({
            projectId,
            orgId,
            readOnly: settings.readOnlyOnAlert,
            revocationPending: settings.revokeOnAlert,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.anomalyState.projectId,
            set: {
              readOnly: sql`${schema.anomalyState.readOnly} OR ${Number(settings.readOnlyOnAlert)}`,
              revocationPending: sql`${schema.anomalyState.revocationPending} OR ${Number(settings.revokeOnAlert)}`,
              updatedAt: now,
            },
          }),
      ],
    );
    if (settings.revokeOnAlert) {
      yield* coordinator.revokeAll(`project:${projectId}`);
      yield* db.query("Anomaly.revoked", (q) =>
        q
          .update(schema.anomalyState)
          .set({ revocationPending: false })
          .where(eq(schema.anomalyState.projectId, projectId)),
      );
    }
  });
  const identity = Effect.fn("Anomalies.identity")(function* (
    orgId: string,
    projectId: string,
    values: ExchangeIdentity | Readonly<Record<string, string | undefined>>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [kind, value] of Object.entries(values)) {
      if (
        !value ||
        value.length > 128 ||
        (!kind.startsWith("ip:") &&
          !["provider", "repositoryId", "ref", "jobWorkflowRef"].includes(kind))
      )
        continue;
      const prior = yield* db.query("Anomaly.identity", (q) =>
        q
          .select()
          .from(schema.anomalyIdentity)
          .where(
            and(
              eq(schema.anomalyIdentity.projectId, projectId),
              eq(schema.anomalyIdentity.kind, kind),
            ),
          )
          .limit(200),
      );
      if (!kind.startsWith("ip:") && !prior.some((row) => row.value === value) && prior.length > 0)
        yield* incident(
          orgId,
          projectId,
          `first_${kind}`,
          `Previously unseen ${kind} on a verified write identity`,
        );
      if (prior.length >= 200 && !prior.some((row) => row.value === value)) continue;
      yield* db.query("Anomaly.identity.upsert", (q) =>
        q
          .insert(schema.anomalyIdentity)
          .values({ projectId, kind, value, firstSeenAt: now, lastSeenAt: now })
          .onConflictDoUpdate({
            target: [
              schema.anomalyIdentity.projectId,
              schema.anomalyIdentity.kind,
              schema.anomalyIdentity.value,
            ],
            set: { lastSeenAt: now, samples: sql`${schema.anomalyIdentity.samples} + 1` },
          }),
      );
    }
  });
  const checkWrite = Effect.fn("Anomalies.checkWrite")(function* (
    orgId: string,
    projectId: string,
    values: ExchangeIdentity,
  ) {
    if ((yield* config(projectId)).enabled) yield* identity(orgId, projectId, values);
    return yield* blocked(projectId);
  });
  const observe = Effect.fn("Anomalies.observe")(function* (
    orgId: string,
    projectId: string,
    allowed: boolean,
    ip: string,
    trustedWrite: boolean,
  ) {
    if (!(yield* config(projectId)).enabled) return;
    const now = yield* Clock.currentTimeMillis,
      hour = Math.floor(now / HOUR) * HOUR;
    yield* db.query("Anomaly.exchange", (q) =>
      q
        .insert(schema.anomalyHour)
        .values({ orgId, projectId, hour, exchanges: 1, denied: allowed ? 0 : 1 })
        .onConflictDoUpdate({
          target: [schema.anomalyHour.projectId, schema.anomalyHour.hour],
          set: {
            exchanges: sql`${schema.anomalyHour.exchanges} + 1`,
            denied: sql`${schema.anomalyHour.denied} + ${allowed ? 0 : 1}`,
          },
        }),
    );
    // IP cardinality is measured only after a successful write-policy match; denied requests cannot poison the baseline.
    if (trustedWrite && ip) {
      const digest = yield* Effect.promise(async () =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip))),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
      yield* identity(orgId, projectId, { [`ip:${hour}`]: digest });
    }
  });
  const write = Effect.fn("Anomalies.write")(function* (
    orgId: string,
    projectId: string,
    hash: string,
    bytes: number,
    signed: boolean,
    values: ExchangeIdentity,
  ) {
    if (!(yield* config(projectId)).enabled) return;
    yield* identity(orgId, projectId, values);
    const now = yield* Clock.currentTimeMillis,
      hour = Math.floor(now / HOUR) * HOUR;
    const [previous] = yield* db.query("Anomaly.overwrite", (q) =>
      q
        .select({ id: schema.artifactOperation.id })
        .from(schema.artifactOperation)
        .where(
          and(
            eq(schema.artifactOperation.projectId, projectId),
            eq(schema.artifactOperation.hash, hash),
            eq(schema.artifactOperation.status, 202),
          ),
        )
        .limit(1),
    );
    if (previous)
      yield* incident(
        orgId,
        projectId,
        "overwrite",
        "An existing content-addressed hash was uploaded again",
      );
    // First week establishes expected signing and hours, then deviations become signals.
    const history = yield* db.query("Anomaly.history", (q) =>
      q
        .select()
        .from(schema.anomalyHour)
        .where(and(eq(schema.anomalyHour.projectId, projectId), lt(schema.anomalyHour.hour, hour)))
        .orderBy(desc(schema.anomalyHour.hour))
        .limit(168),
    );
    if (
      !signed &&
      history.reduce((sum, row) => sum + row.signed, 0) >= 20 &&
      history.every((row) => row.unsigned === 0)
    )
      yield* incident(
        orgId,
        projectId,
        "unsigned",
        "Unsigned upload on a project with an established signing baseline",
      );
    if (
      history.filter((row) => row.writes > 0).length >= 24 &&
      !history.some(
        (row) =>
          row.writes > 0 && new Date(row.hour).getUTCHours() === new Date(hour).getUTCHours(),
      )
    )
      yield* incident(
        orgId,
        projectId,
        "unusual_hour",
        "Write outside established UTC activity hours",
      );
    yield* db.query("Anomaly.write", (q) =>
      q
        .insert(schema.anomalyHour)
        .values({
          orgId,
          projectId,
          hour,
          writes: 1,
          bytes,
          signed: signed ? 1 : 0,
          unsigned: signed ? 0 : 1,
        })
        .onConflictDoUpdate({
          target: [schema.anomalyHour.projectId, schema.anomalyHour.hour],
          set: {
            writes: sql`${schema.anomalyHour.writes} + 1`,
            bytes: sql`${schema.anomalyHour.bytes} + ${bytes}`,
            signed: sql`${schema.anomalyHour.signed} + ${signed ? 1 : 0}`,
            unsigned: sql`${schema.anomalyHour.unsigned} + ${signed ? 0 : 1}`,
          },
        }),
    );
  });
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis,
      hour = Math.floor(now / HOUR) * HOUR;
    const pending = yield* db.query("Anomaly.pending", (q) =>
      q
        .select()
        .from(schema.anomalyState)
        .where(eq(schema.anomalyState.revocationPending, true))
        .limit(100),
    );
    for (const state of pending) {
      yield* coordinator.revokeAll(`project:${state.projectId}`);
      yield* db.query("Anomaly.revocation.complete", (q) =>
        q
          .update(schema.anomalyState)
          .set({ revocationPending: false })
          .where(eq(schema.anomalyState.projectId, state.projectId)),
      );
    }
    const hours = yield* db.query("Anomaly.hours", (q) =>
      q
        .select()
        .from(schema.anomalyHour)
        .where(and(eq(schema.anomalyHour.checked, false), lt(schema.anomalyHour.hour, hour)))
        .orderBy(schema.anomalyHour.hour)
        .limit(100),
    );
    for (const row of hours) {
      const settings = yield* config(row.projectId);
      const baseline = yield* db.query("Anomaly.baseline", (q) =>
        q
          .select()
          .from(schema.anomalyHour)
          .where(
            and(
              eq(schema.anomalyHour.projectId, row.projectId),
              lt(schema.anomalyHour.hour, row.hour),
            ),
          )
          .orderBy(desc(schema.anomalyHour.hour))
          .limit(168),
      );
      const average = baseline.reduce((n, b) => n + b.writes, 0) / Math.max(1, baseline.length);
      if (
        baseline.length >= 3 &&
        row.writes >= settings.minHourlyWrites &&
        row.writes > average * settings.volumeMultiplier
      )
        yield* incident(
          row.orgId,
          row.projectId,
          "volume_spike",
          "Hourly writes exceeded the configured baseline multiplier",
        );
      if (row.exchanges >= 20 && row.denied / row.exchanges >= 0.5)
        yield* incident(
          row.orgId,
          row.projectId,
          "exchange_denials",
          "At least half of twenty or more exchanges were denied",
        );
      const ips = yield* db.query("Anomaly.ips", (q) =>
        q
          .select()
          .from(schema.anomalyIdentity)
          .where(
            and(
              eq(schema.anomalyIdentity.projectId, row.projectId),
              eq(schema.anomalyIdentity.kind, `ip:${row.hour}`),
            ),
          )
          .limit(settings.maxExchangeIPs + 1),
      );
      if (ips.length > settings.maxExchangeIPs)
        yield* incident(
          row.orgId,
          row.projectId,
          "exchange_ips",
          "Successful write exchanges from unusually many IP addresses",
        );
      yield* db.query("Anomaly.checked", (q) =>
        q
          .update(schema.anomalyHour)
          .set({ checked: true })
          .where(
            and(
              eq(schema.anomalyHour.projectId, row.projectId),
              eq(schema.anomalyHour.hour, row.hour),
            ),
          ),
      );
    }
    const incidents = yield* db.query("Anomaly.delivery", (q) =>
      q
        .select()
        .from(schema.anomalyIncident)
        .where(eq(schema.anomalyIncident.delivered, false))
        .limit(100),
    );
    for (const item of incidents) {
      const admins = yield* db.query("Anomaly.admins", (q) =>
        q
          .select({ id: schema.user.id, email: schema.user.email, role: schema.member.role })
          .from(schema.member)
          .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
          .where(eq(schema.member.organizationId, item.orgId)),
      );
      for (const admin of admins.filter((member) =>
        member.role.split(",").some((role) => ["owner", "admin"].includes(role.trim())),
      ))
        yield* alerts.notify({
          id: `${item.id}:${admin.id}`,
          userId: admin.id,
          to: admin.email,
          kind: "anomaly",
          detail: `${item.projectId}: ${item.detail}`,
          consoleURL: `${origin}/#audit`,
        });
      yield* db.query("Anomaly.delivered", (q) =>
        q
          .update(schema.anomalyIncident)
          .set({ delivered: true })
          .where(eq(schema.anomalyIncident.id, item.id)),
      );
    }
    yield* db.batch((q) => [
      q
        .delete(schema.anomalyHour)
        .where(
          and(
            eq(schema.anomalyHour.checked, true),
            lt(schema.anomalyHour.hour, now - 8 * 24 * HOUR),
          ),
        ),
      q
        .delete(schema.anomalyIdentity)
        .where(lt(schema.anomalyIdentity.lastSeenAt, now - 8 * 24 * HOUR)),
    ]);
  });
  const configure = (
    projectId: string,
    input: typeof defaults,
    event: AuditInput,
    resume: boolean,
  ) =>
    audit.commit(event, (q) => [
      q
        .insert(schema.anomalyConfig)
        .values({ projectId, ...input })
        .onConflictDoUpdate({ target: schema.anomalyConfig.projectId, set: input }),
      ...(resume
        ? [
            q
              .update(schema.anomalyState)
              .set({ readOnly: false })
              .where(
                and(
                  eq(schema.anomalyState.projectId, projectId),
                  eq(schema.anomalyState.revocationPending, false),
                ),
              ),
          ]
        : []),
    ]);
  return { config, blocked, checkWrite, observe, write, tick, configure };
});
export class Anomalies extends Context.Service<Anomalies, Effect.Success<typeof makeAnomalies>>()(
  "server/Anomalies",
) {}
export const AnomaliesLive = Layer.effect(Anomalies, makeAnomalies);

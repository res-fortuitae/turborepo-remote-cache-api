import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const project = sqliteTable(
  "project",
  {
    id: text().primaryKey(),
    orgId: text("org_id").notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    retentionDays: integer("retention_days"),
    maxArtifactBytes: integer("max_artifact_bytes"),
    createdAt: integer("created_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (t) => [uniqueIndex("project_org_slug").on(t.orgId, t.slug)],
);

export const projectGrant = sqliteTable(
  "project_grant",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    principalType: text("principal_type", { enum: ["user", "team"] }).notNull(),
    principalId: text("principal_id").notNull(),
    role: text({ enum: ["project:admin", "cache:write", "cache:read"] }).notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.principalType, t.principalId] }),
    check("grant_principal_type", sql`${t.principalType} in ('user', 'team')`),
    check("grant_role", sql`${t.role} in ('project:admin', 'cache:write', 'cache:read')`),
  ],
);

export interface TrustPolicyBody {
  issuer: string;
  claims: Record<string, string[]>;
  label?: string;
  scope: "read" | "read write";
  ttlSeconds: number;
  refPatterns?: string[];
  requireBoundTokens?: boolean;
}

export const trustPolicy = sqliteTable(
  "trust_policy",
  {
    id: text().primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    provider: text({
      enum: [
        "github",
        "gitlab",
        "circleci",
        "buildkite",
        "bitbucket",
        "vercel",
        "aws-eks",
        "google",
        "azure",
        "custom",
      ],
    }).notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull().default(0),
    body: text({ mode: "json" }).$type<TrustPolicyBody>().notNull(),
  },
  (t) => [index("trust_policy_project").on(t.projectId)],
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Singleton settings are versioned by the owning deployment/config domain. */
export const instanceSettings = sqliteTable(
  "instance_settings",
  {
    id: integer().primaryKey().default(1),
    schemaVersion: integer("schema_version").notNull(),
    settings: text({ mode: "json" }).$type<JsonObject>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("instance_settings_singleton", sql`${t.id} = 1`)],
);

/**
 * Event payload validation and hash-chain semantics belong to @repo/audit.
 * `(chain, sequence)` is unique, so two writers can't both extend a chain from
 * the same head: the loser's batch fails and it retries (STV-482).
 */
export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: text().primaryKey(),
    ts: integer().notNull(),
    schemaVersion: integer("schema_version").notNull(),
    orgId: text("org_id"),
    projectId: text("project_id"),
    payload: text({ mode: "json" }).$type<JsonObject>().notNull(),
    prevHash: text("prev_hash"),
    hash: text(),
    exportedAt: integer("exported_at"),
    chain: text(),
    sequence: integer(),
  },
  (t) => [
    index("audit_event_outbox").on(t.exportedAt, t.ts, t.id),
    uniqueIndex("audit_event_chain").on(t.chain, t.sequence),
  ],
);

export const rollup = sqliteTable(
  "rollup",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    bucketStart: integer("bucket_start").notNull(),
    metric: text().notNull(),
    value: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.projectId, t.bucketStart, t.metric] })],
);

/**
 * Accepted OIDC token ids, for replay protection (STV-483). The primary key
 * makes "insert if not already present" atomic; expired rows may be reclaimed.
 */
export const oidcJti = sqliteTable(
  "oidc_jti",
  {
    issuer: text().notNull(),
    jti: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.issuer, t.jti] }), index("oidc_jti_expiry").on(t.expiresAt)],
);

/** Explicit, short-lived access; never implies permanent organization membership. */
export const orgElevation = sqliteTable("org_elevation", {
  id: text().primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  orgId: text("org_id").notNull(),
  reason: text().notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const orgLifecycle = sqliteTable("org_lifecycle", {
  orgId: text("org_id").primaryKey(),
  archivedAt: integer("archived_at"),
});

/** Durable fallback for transactional alerts when mail delivery is unavailable. */
export const notification = sqliteTable("notification", {
  id: text().primaryKey(),
  userId: text("user_id").notNull(),
  kind: text().notNull(),
  detail: text().notNull(),
  createdAt: integer("created_at").notNull(),
});

export const invitationClaim = sqliteTable("invitation_claim", {
  invitationId: text("invitation_id").primaryKey(),
  nonce: text().notNull(),
});
export const invitationWindow = sqliteTable("invitation_window", {
  key: text().primaryKey(),
  count: integer().notNull(),
});

export const organizationPolicy = sqliteTable("organization_policy", {
  orgId: text("org_id").primaryKey(),
  settings: text({ mode: "json" }).$type<JsonObject>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const passkeyProof = sqliteTable("passkey_proof", {
  sessionId: text("session_id").primaryKey(),
  userId: text("user_id").notNull(),
  verifiedAt: integer("verified_at").notNull(),
});

/** Tombstones permanently invalidate credentials, even after cleanup completes. */
export const projectDeletion = sqliteTable(
  "project_deletion",
  {
    projectId: text("project_id").primaryKey(),
    orgId: text("org_id").notNull(),
    requestedAt: integer("requested_at").notNull(),
    cursor: text(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("project_deletion_pending").on(t.completedAt, t.requestedAt)],
);

/** Persisted cursors make per-prefix retention bounded across cron invocations. */
export const projectRetention = sqliteTable("project_retention", {
  projectId: text("project_id").primaryKey(),
  cursor: text(),
  scannedAt: integer("scanned_at").notNull().default(0),
});

/** API-key epoch stamps and usage are separate from the plugin's mutable counters. */
export const cacheApiKey = sqliteTable("cache_api_key", {
  id: text().primaryKey(),
  orgId: text("org_id").notNull(),
  projectId: text("project_id").notNull(),
  orgEpoch: integer("org_epoch").notNull(),
  projectEpoch: integer("project_epoch").notNull(),
  lastUsedAt: integer("last_used_at"),
});

/** Durable incident-response scans and bounded deletion checkpoints. */
export const artifactPurgeJob = sqliteTable("artifact_purge_job", {
  id: text().primaryKey(),
  projectId: text("project_id").notNull(),
  state: text().notNull(),
  leaseUntil: integer("lease_until").notNull().default(0),
  data: text().notNull(),
});

/** Upload provenance stays queryable before the full M7 analytics sink is enabled. */
export const artifactOperation = sqliteTable("artifact_operation", {
  status: integer().notNull().default(202),
  id: text().primaryKey(),
  orgId: text("org_id").notNull(),
  projectId: text("project_id").notNull(),
  hash: text().notNull(),
  createdAt: integer("created_at").notNull(),
  provenance: text({ mode: "json" }).$type<Readonly<Record<string, string>>>().notNull(),
});

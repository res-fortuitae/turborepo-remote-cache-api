/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes the policy suite at the boundary. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { Authorization } from "./authorization.ts";
import {
  actions,
  decide,
  type Action,
  type CredentialPrincipal,
  type DecisionFacts,
  type Policy,
  type Principal,
} from "./decision.ts";
import { AuthorizationTest } from "./testing.ts";

// This acceptance table is intentionally separate from the implementation and role definitions.
const actionTable = {
  create: "org",
  read: "read",
  update: "admin",
  delete: "admin",
  grant: "admin",
  "cache:read": "read",
  "cache:write": "write",
  "trustPolicy:create": "admin",
  "trustPolicy:update": "admin",
  "trustPolicy:delete": "admin",
  "apiKey:create": "admin",
  "apiKey:revoke": "admin",
  "audit:read": "audit",
  "audit:export": "org",
  "analytics:read": "audit",
  "settings:update": "org",
} as const;
const instanceRoles = ["owner", "admin", "auditor", "member"] as const;
const orgRoles = [null, "owner", "admin", "member", "auditor", "custom"] as const;
const grants = [null, "cache:read", "cache:write", "project:admin"] as const;
type Grant = (typeof grants)[number];
type OrgRole = (typeof orgRoles)[number];
interface Row {
  readonly instance: (typeof instanceRoles)[number];
  readonly elevated: boolean;
  readonly org: OrgRole;
  readonly direct: Grant;
  readonly team: Grant;
  readonly inTeam: boolean;
}
const rows: Row[] = [];
for (const instance of instanceRoles)
  for (const elevated of [false, true])
    for (const org of orgRoles)
      for (const direct of grants)
        for (const team of grants)
          for (const inTeam of [false, true])
            rows.push({ instance, elevated, org, direct, team, inTeam });

const effectiveGrant = (row: Row): Grant => {
  if (!row.org) return null;
  if (row.org === "owner" || row.org === "admin") return "project:admin";
  return (
    grants[Math.max(grants.indexOf(row.direct), row.inTeam ? grants.indexOf(row.team) : 0)] ?? null
  );
};
const orgAllows = (role: OrgRole, action: Action) =>
  role === "owner" ||
  role === "admin" ||
  (role === "auditor" && (action === "audit:read" || action === "analytics:read")) ||
  (role === "custom" && (action === "read" || action === "trustPolicy:create"));
const expected = (row: Row, principal: Principal, action: Action) => {
  if ("kind" in principal)
    return (
      action === "cache:read" || (action === "cache:write" && principal.scope === "read write")
    );
  if (row.elevated && (row.instance === "owner" || row.instance === "admin")) return true;
  if (!row.org) return false;
  if (orgAllows(row.org, action)) return true;
  const role = effectiveGrant(row);
  return (
    (actionTable[action] === "read" && role !== null) ||
    (actionTable[action] === "write" && (role === "cache:write" || role === "project:admin")) ||
    (actionTable[action] === "admin" && role === "project:admin")
  );
};
const principals = (now: number): Principal[] => [
  { userId: "u", sessionId: "s" },
  ...(["apiKey", "cacheJwt"] as const).flatMap((kind) =>
    (["read", "read write"] as const).map((scope) => ({
      kind,
      id: `${kind}-${scope}`,
      orgId: "org",
      projectId: "a",
      scope,
      issuedAt: now - 1,
      expiresAt: now + 100,
    })),
  ),
];
const factsFor = (row: Row, action: Action): DecisionFacts => ({
  active: true,
  member: row.org !== null,
  instanceRole: row.instance,
  elevated: row.elevated,
  projectRole: effectiveGrant(row),
  orgPermission: orgAllows(row.org, action),
  exists: true,
  archived: false,
  orgArchived: false,
});
const policy: Policy = {
  maxTokenTtlSeconds: 900,
  maxApiKeyLifetimeDays: 30,
  requireArtifactSigning: false,
  requireBoundTokens: false,
  apiKeys: "allowed",
};
const resource = { orgId: "org", projectId: "a" };

const verify = (allowed: boolean, row: Row, principal: Principal, action: Action) => {
  if (allowed !== expected(row, principal, action))
    throw new Error(`Matrix mismatch: ${JSON.stringify({ row, principal, action, allowed })}`);
};

test("pure matrix: every instance/elevation/org/direct/team/membership/credential/action combination", () => {
  expect(actions.join(",")).toBe(Object.keys(actionTable).join(","));
  let count = 0;
  for (const row of rows)
    for (const principal of principals(200))
      for (const action of actions) {
        verify(
          decide(principal, action, resource, factsFor(row, action), policy, 200).allowed,
          row,
          principal,
          action,
        );
        count++;
      }
  expect(count).toBe(122880);
});

test(
  "AuthorizationTest matrix resolves the full Cartesian product from current database fixtures",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const authorization = yield* Authorization;
        const now = new Date("2026-01-01T00:00:00Z");
        yield* database.batch((db) => [
          db.insert(schema.user).values({
            id: "u",
            name: "User",
            email: "u@example.com",
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(schema.session).values({
            id: "s",
            token: "token",
            userId: "u",
            expiresAt: new Date("2099-01-01"),
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(schema.organization).values([
            { id: "org", name: "Org", slug: "org", createdAt: now },
            { id: "other", name: "Other", slug: "other", createdAt: now },
          ]),
          db.insert(schema.project).values([
            { id: "a", orgId: "org", name: "A", slug: "a", createdAt: 0 },
            { id: "b", orgId: "org", name: "B", slug: "b", createdAt: 0 },
            { id: "c", orgId: "other", name: "C", slug: "c", createdAt: 0 },
          ]),
          db
            .insert(schema.team)
            .values({ id: "team", organizationId: "org", name: "Team", createdAt: now }),
          db.insert(schema.organizationRole).values({
            id: "custom",
            organizationId: "org",
            role: "custom",
            permission: JSON.stringify({ project: ["read"], trustPolicy: ["create"] }),
            createdAt: now,
          }),
        ]);
        const identities = principals(Math.floor((yield* Clock.currentTimeMillis) / 1000));
        let count = 0;
        for (const row of rows) {
          yield* database.batch((db) => [
            db.update(schema.user).set({ role: row.instance }).where(eq(schema.user.id, "u")),
            db.delete(schema.member),
            db.delete(schema.orgElevation),
            db.delete(schema.projectGrant),
            db.delete(schema.teamMember),
          ]);
          if (row.org)
            yield* database.query("matrix.member", (db) =>
              db.insert(schema.member).values({
                id: "member",
                userId: "u",
                organizationId: "org",
                role: row.org ?? "member",
                createdAt: now,
              }),
            );
          if (row.elevated)
            yield* database.query("matrix.elevation", (db) =>
              db.insert(schema.orgElevation).values({
                id: "elevation",
                userId: "u",
                sessionId: "s",
                orgId: "org",
                reason: "matrix",
                expiresAt: new Date("2099-01-01").getTime(),
              }),
            );
          if (row.direct)
            yield* database.query("matrix.direct", (db) =>
              db.insert(schema.projectGrant).values({
                projectId: "a",
                principalType: "user",
                principalId: "u",
                role: row.direct!,
                grantedBy: "u",
                createdAt: 0,
              }),
            );
          if (row.team)
            yield* database.query("matrix.team", (db) =>
              db.insert(schema.projectGrant).values({
                projectId: "a",
                principalType: "team",
                principalId: "team",
                role: row.team!,
                grantedBy: "u",
                createdAt: 0,
              }),
            );
          if (row.inTeam)
            yield* database.query("matrix.teamMember", (db) =>
              db
                .insert(schema.teamMember)
                .values({ id: "tm", teamId: "team", userId: "u", createdAt: now }),
            );
          for (const principal of identities)
            for (const action of actions) {
              verify(
                (yield* authorization.can(principal, action, resource)).allowed,
                row,
                principal,
                action,
              );
              count++;
              if ("kind" in principal) {
                expect(
                  (yield* authorization.can(principal, action, { orgId: "other", projectId: "c" }))
                    .allowed,
                ).toBe(false);
                expect(
                  (yield* authorization.can(principal, action, { orgId: "org", projectId: "b" }))
                    .allowed,
                ).toBe(false);
              }
            }
        }
        expect(count).toBe(122880);
      }).pipe(Effect.provide(AuthorizationTest)),
    ),
  120_000,
);

test("policy and resource gates override every role and credential across every action", () => {
  for (const row of rows)
    for (const principal of principals(200))
      for (const action of actions) {
        const facts = factsFor(row, action);
        expect(
          decide(principal, action, resource, { ...facts, deleted: true }, policy, 200).allowed,
        ).toBe(false);
        expect(
          decide(
            principal,
            action,
            { ...resource, requestedPolicy: { maxTokenTtlSeconds: 901 } },
            facts,
            policy,
            200,
          ).allowed,
        ).toBe(false);
        expect(
          decide(
            principal,
            action,
            { ...resource, requestedPolicy: { requireArtifactSigning: false } },
            facts,
            { ...policy, requireArtifactSigning: true },
            200,
          ).allowed,
        ).toBe(false);
        if ("kind" in principal) {
          expect(
            decide(principal, action, { ...resource, orgId: "other" }, facts, policy, 200).allowed,
          ).toBe(false);
          expect(
            decide(principal, action, { ...resource, projectId: "b" }, facts, policy, 200).allowed,
          ).toBe(false);
          expect(
            decide({ ...principal, expiresAt: 199 }, action, resource, facts, policy, 200).allowed,
          ).toBe(false);
        }
      }
});

const credential: CredentialPrincipal = {
  kind: "cacheJwt",
  id: "t",
  ...resource,
  scope: "read write",
  issuedAt: 100,
  expiresAt: 300,
};
test.each(actions)("policy edge cases for %s", (action) => {
  const row = rows[0]!;
  const facts = { ...factsFor(row, action), elevated: true, instanceRole: "owner" };
  expect(
    decide(credential, action, resource, facts, { ...policy, requireBoundTokens: true }, 200)
      .allowed,
  ).toBe(false);
  expect(
    decide(
      { ...credential, kind: "apiKey" },
      action,
      resource,
      facts,
      { ...policy, apiKeys: "disallowed" },
      200,
    ).allowed,
  ).toBe(false);
  expect(
    decide(credential, action, resource, facts, { ...policy, maxTokenTtlSeconds: 199 }, 200)
      .allowed,
  ).toBe(false);
  if (action === "cache:write") {
    expect(
      decide(credential, action, resource, facts, { ...policy, requireArtifactSigning: true }, 200)
        .allowed,
    ).toBe(false);
    expect(
      decide(
        { ...credential, signed: true, bound: true },
        action,
        resource,
        facts,
        { ...policy, requireArtifactSigning: true, requireBoundTokens: true },
        200,
      ).allowed,
    ).toBe(true);
  }
});

import { expect, test } from "bun:test";
import { explainAccess, type AccessFacts } from "./access.ts";

const base: AccessFacts = {
  userId: "alice",
  orgRole: "member",
  customRoles: [],
  grants: [],
  groupMembers: new Map([["g1", new Set(["alice"])]]),
  groupNames: new Map([["g1", "Platform"]]),
  archived: false,
};

test("explains write access through a group grant", () => {
  const result = explainAccess(
    { ...base, grants: [{ principalType: "team", principalId: "g1", role: "cache:write" }] },
    "cache:write",
  );

  expect(result.allowed).toBe(true);
  expect(result.reasons[0]).toContain('group "Platform"');
});

test("lists every path, direct and group", () => {
  const result = explainAccess(
    {
      ...base,
      grants: [
        { principalType: "user", principalId: "alice", role: "cache:read" },
        { principalType: "team", principalId: "g1", role: "project:admin" },
      ],
    },
    "cache:read",
  );

  expect(result.reasons).toHaveLength(2);
});

test("org admins manage projects but never get cache access from their role", () => {
  const admin = { ...base, orgRole: "admin" };

  expect(explainAccess(admin, "update").allowed).toBe(true);
  expect(explainAccess(admin, "cache:read")).toEqual({
    allowed: false,
    reasons: [expect.stringContaining("never grant cache access")],
  });
});

test("read-only grants, archived projects and non-members are denied writes", () => {
  const reader = {
    ...base,
    grants: [{ principalType: "user" as const, principalId: "alice", role: "cache:read" as const }],
  };

  expect(explainAccess(reader, "cache:write").allowed).toBe(false);
  expect(
    explainAccess(
      {
        ...base,
        archived: true,
        grants: [{ principalType: "user", principalId: "alice", role: "project:admin" }],
      },
      "cache:write",
    ).allowed,
  ).toBe(false);
  expect(explainAccess({ ...base, orgRole: undefined }, "read").allowed).toBe(false);
});

test("custom roles with project statements count, other members' grants do not", () => {
  const custom = {
    ...base,
    orgRole: "release-manager",
    customRoles: [{ id: "r", role: "release-manager", permission: { project: ["update"] } }],
  };

  expect(explainAccess(custom, "update").allowed).toBe(true);
  expect(
    explainAccess(
      { ...base, grants: [{ principalType: "user", principalId: "bob", role: "project:admin" }] },
      "read",
    ).allowed,
  ).toBe(false);
});

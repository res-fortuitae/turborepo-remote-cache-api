import { expect, test } from "bun:test";
import { matchRoute, splitLocation } from "./router.tsx";

test("matches static and parameter segments", () => {
  expect(matchRoute("/orgs/:org/projects/:id", "/orgs/acme/projects/p1")).toEqual({
    org: "acme",
    id: "p1",
  });
  expect(matchRoute("/", "/")).toEqual({});
  expect(matchRoute("/purge", "/purge/")).toEqual({});
});

test("rejects different shapes and malformed escapes", () => {
  expect(matchRoute("/orgs/:org", "/orgs/acme/extra")).toBeUndefined();
  expect(matchRoute("/purge", "/members")).toBeUndefined();
  expect(matchRoute("/orgs/:org", "/orgs/%E0%A4%A")).toBeUndefined();
});

test("decodes parameters", () => {
  expect(matchRoute("/projects/:id", "/projects/a%2Fb")).toEqual({ id: "a/b" });
});

test("splits a hash location into path and query", () => {
  const { path, params } = splitLocation("/orgs/acme/audit?outcome=deny&actor=u1");

  expect(path).toBe("/orgs/acme/audit");
  expect(params.get("outcome")).toBe("deny");
  expect(params.get("actor")).toBe("u1");
});

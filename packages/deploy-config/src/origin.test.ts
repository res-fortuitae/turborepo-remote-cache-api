import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { matchOidcAudience, resolveOriginSettings } from "./origin.ts";

test("audiences default to each stage's canonical origin", () => {
  for (const origin of [
    "https://cache.example.com",
    "https://staging.example.com",
    "https://cache.account.workers.dev",
    "http://localhost:1337",
  ]) {
    expect(resolveOriginSettings(origin)).toEqual({
      canonicalOrigin: origin,
      oidcAudiences: [origin],
    });
  }
});

test("pinned CI audiences survive an origin change and keep exact identifiers", () => {
  expect(
    resolveOriginSettings("https://new.example.com", [
      "https://old.example.com",
      "urn:acme:turbo",
      "https://old.example.com",
    ]),
  ).toEqual({
    canonicalOrigin: "https://new.example.com",
    oidcAudiences: ["https://old.example.com", "urn:acme:turbo"],
  });
});

test("matching returns the exact accepted string for scalar and array JWT audiences", () => {
  const accepted = ["https://old.example.com", "urn:acme:turbo"];

  expect(matchOidcAudience(accepted, "urn:acme:turbo")).toEqual(Option.some("urn:acme:turbo"));
  expect(matchOidcAudience(accepted, ["other", "https://old.example.com"])).toEqual(
    Option.some("https://old.example.com"),
  );
  expect(matchOidcAudience(accepted, "https://old.example.com/evil")).toEqual(Option.none());
  expect(matchOidcAudience(accepted, "https://OLD.example.com")).toEqual(Option.none());
  expect(matchOidcAudience(accepted, [])).toEqual(Option.none());
});

test("invalid origins and empty audience allowlists fail closed", () => {
  for (const origin of [
    "https://cache.example.com/",
    "https://user:pass@cache.example.com",
    "https://cache.example.com/path",
    "https://cache.example.com?query",
    "http://cache.example.com",
    "file:///tmp/cache",
  ]) {
    expect(() => resolveOriginSettings(origin)).toThrow();
  }

  expect(() => resolveOriginSettings("https://cache.example.com", [])).toThrow();
  expect(() => resolveOriginSettings("https://cache.example.com", [""])).toThrow();
  expect(() => resolveOriginSettings("https://cache.example.com", [" padded "])).toThrow();
});

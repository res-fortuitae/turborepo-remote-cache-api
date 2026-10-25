import { expect, test } from "bun:test";
import { Schema } from "effect";
import { CustomOidcIssuers } from "./index.ts";

const valid = Schema.is(CustomOidcIssuers);
const key = { kty: "RSA", alg: "RS256", kid: "key", n: "public_modulus", e: "AQAB" };

test("custom issuer pins are bounded public-key configuration with canonical public HTTPS names", () => {
  expect(valid([{ issuer: "https://identity.acme.com/tenant", keys: [key] }])).toBe(true);

  for (const issuer of [
    "http://identity.acme.com",
    "https://localhost",
    "https://private.local",
    "https://169.254.169.254",
    "https://127.1",
    "https://0x7f000001",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://user@identity.acme.com",
    "https://identity.acme.com?x=1",
    "https://identity.acme.com/#x",
    "https://identity.acme.com:8443",
    "https://identity.acme.com/../other",
  ]) {
    expect(valid([{ issuer, keys: [key] }])).toBe(false);
  }

  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
    expect(
      valid([{ issuer: "https://identity.acme.com", keys: [{ ...key, [field]: "secret" }] }]),
    ).toBe(false);
  }

  for (const keys of [
    [],
    Array.from({ length: 11 }, () => key),
    [{ ...key, kty: "oct" }],
    [{ ...key, alg: "HS256" }],
  ]) {
    expect(valid([{ issuer: "https://identity.acme.com", keys }])).toBe(false);
  }

  expect(
    valid(Array.from({ length: 2 }, () => ({ issuer: "https://identity.acme.com", keys: [key] }))),
  ).toBe(false);
});

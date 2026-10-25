import { expect, test } from "bun:test";
import { Redacted } from "effect";
import { signInviteLink, verifyInviteLink } from "./invite-link.ts";
const config = {
  secret: Redacted.make("test-secret-test-secret-test-secret"),
  baseURL: "https://cache.test",
  trustedOrigins: [],
};
test("invitation signatures bind id and expiry and reject tampering", async () => {
  const expiry = new Date("2099-01-01T00:00:00Z");
  const url = new URL(await signInviteLink(config, "invite-1", expiry));
  const signature = new URLSearchParams(url.hash.split("?")[1]).get("signature") ?? "";
  expect(await verifyInviteLink(config, "invite-1", expiry, signature)).toBe(true);
  expect(await verifyInviteLink(config, "invite-2", expiry, signature)).toBe(false);
  expect(await verifyInviteLink(config, "invite-1", new Date(0), signature)).toBe(false);
  expect(await verifyInviteLink(config, "invite-1", expiry, "broken")).toBe(false);
});

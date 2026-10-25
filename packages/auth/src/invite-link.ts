import * as Redacted from "effect/Redacted";
import type { AuthSettings } from "@repo/deploy-config";

const keyFor = (config: AuthSettings) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Redacted.value(config.secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
const payload = (id: string, expiry: number) =>
  new TextEncoder().encode(`org-invitation:${id}:${expiry}`);
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The invitation row supplies identity, expiry, and atomic single-use status. */
export const signInviteLink = async (config: AuthSettings, id: string, expiresAt: Date) => {
  if (!config.baseURL) throw new Error("Invitation links require the canonical origin");
  const expiry = expiresAt.getTime();
  const signature = hex(
    await crypto.subtle.sign("HMAC", await keyFor(config), payload(id, expiry)),
  );
  const url = new URL("/", config.baseURL);
  url.hash = `invitation?id=${encodeURIComponent(id)}&expires=${expiry}&signature=${signature}`;
  return url.href;
};
export const verifyInviteLink = async (
  config: AuthSettings,
  id: string,
  expiresAt: Date,
  signature: string,
) => {
  if (expiresAt.getTime() <= Date.now() || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify(
    "HMAC",
    await keyFor(config),
    bytes,
    payload(id, expiresAt.getTime()),
  );
};

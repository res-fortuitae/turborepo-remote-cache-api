/** Exact Vercel identity paths used by Turbo 1.13.4 and 2.11.10 (see docs). */
export const isTurboIdentityPath = (path: string) =>
  /^\/(?:v2\/(?:user|teams(?:\/[^/]+)?)|v0\/spaces|v[35]\/user\/tokens\/current|registration\/verify|\.well-known\/openid-configuration|login\/oauth\/(?:userinfo|device-authorization|token(?:\/(?:introspect|revoke))?))\/?$/.test(
    path,
  );

export const TURBO_COMPATIBILITY_DOCS =
  "https://github.com/StvyaSharma/turborepo-remote-cache-api/blob/main/docs/turbo-compatibility.md";

/** Explicit Authorization is required by Turbo before it sends the actual request. */
export const TURBO_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, POST, OPTIONS",
  "access-control-allow-headers":
    "Authorization, Content-Type, Content-Length, User-Agent, X-Artifact-Tag, X-Artifact-Duration, X-Artifact-Sha, X-Artifact-Dirty-Hash, X-Artifact-Client-Ci, X-Artifact-Client-Interactive",
  "cache-control": "no-store",
} as const;

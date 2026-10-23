/**
 * A cache API under test. Unit suites dispatch requests to the in-process
 * handler; integration and deployed suites send them to a running Worker.
 */
export interface Target {
  readonly token: string;
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export const httpTarget = (api: string, token: string): Target => {
  const base = api.replace(/\/+$/, "");

  return {
    token,
    fetch: (path, init) =>
      // Rejections may skip the request body; local workerd then resets a reused socket.
      fetch(`${base}${path}`, { ...init, keepalive: false, signal: AbortSignal.timeout(30_000) }),
  };
};

/** A team per run so suites never observe each other's artifacts. */
export const uniqueTeam = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

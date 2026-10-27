/** Dispatch through auth.api.getSession so bearer normalization runs before session lookup.
 * Better Auth accumulates before-hook header changes until all before hooks finish;
 * reading its raw session endpoint inside another before hook misses those changes.
 * Callers still confirm live session/user state in D1 before authorizing mutations.
 */
export type SessionReader = (headers: Headers | undefined) => Promise<{
  session: { id: string; token: string };
  user: { id: string };
} | null>;

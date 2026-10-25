import { RateLimiter, betterAuthRateLimitStorage } from "@repo/ratelimit";
import {
  ApiKeyLookup,
  ApiKeyEpochs,
  ApiKeyBackground,
  ApiKeyVerificationError,
  makeApiKeys,
} from "./api-keys.ts";
import { AuditLog } from "@repo/audit";
import { Database, schema, type DatabaseError } from "@repo/db";
import { AuthConfig } from "@repo/deploy-config";
import { invitationMessage, Mailer } from "@repo/mailer";
import { isAPIError } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  makeBetterAuth,
  type BetterAuthInstance,
  type BetterAuthSecondaryStorage,
} from "./options.ts";
import { SecondaryStorage, type SecondaryStorageService } from "./secondary-storage.ts";

export type AuthSession = BetterAuthInstance["$Infer"]["Session"];

/** A Better Auth call failed; `status` is the HTTP status it would have returned. */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  operation: Schema.String,
  status: Schema.Number,
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

/** No valid session. `revoked` means the cache still held a session D1 no longer has. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  reason: Schema.Literals(["missing", "revoked"]),
}) {}

export interface AuthService {
  /** Serves `/api/auth/*`. Better Auth turns its own errors into responses. */
  readonly handler: (request: Request) => Effect.Effect<Response, AuthError>;
  /** The session for these request headers. May come from the KV cache. */
  readonly getSession: (headers: Headers) => Effect.Effect<Option.Option<AuthSession>, AuthError>;
  readonly requireSession: (
    headers: Headers,
  ) => Effect.Effect<AuthSession, AuthError | Unauthenticated>;
  /**
   * Like `requireSession`, then confirms the session is still live in D1.
   * Use it for sensitive actions: admin changes, elevation, token issue.
   */
  readonly requireFreshSession: (
    headers: Headers,
  ) => Effect.Effect<AuthSession, AuthError | Unauthenticated | DatabaseError>;
  /** Revokes every session of the caller's user. */
  readonly revokeSessions: (headers: Headers) => Effect.Effect<void, AuthError>;
}

export class Auth extends Context.Service<Auth, AuthService>()("@repo/auth/Auth") {}

const callBetterAuth = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isAPIError(cause)
        ? new AuthError({ operation, status: cause.statusCode, message: cause.message, cause })
        : new AuthError({ operation, status: 500, message: "Better Auth failed", cause }),
  });

/** KV can't get-and-delete or increment atomically; the options never route these to it. */
const unsupported = (operation: string) => () =>
  Promise.reject(
    new Error(`SecondaryStorage.${operation} needs atomicity that KV lacks (ADR 0002)`),
  );

const toBetterAuthStorage = (storage: SecondaryStorageService): BetterAuthSecondaryStorage => ({
  get: (key) => Effect.runPromise(Effect.map(storage.get(key), Option.getOrNull)),
  set: (key, value, ttl) => Effect.runPromise(storage.set(key, value, ttl)),
  delete: (key) => Effect.runPromise(storage.delete(key)),
  getAndDelete: unsupported("getAndDelete"),
  increment: unsupported("increment"),
});

/**
 * Builds one Better Auth instance per layer build. Workers resolve the D1
 * binding per request, so the app builds this layer per request.
 * `SecondaryStorage` is optional; without it sessions are read from D1.
 */
export const AuthLive: Layer.Layer<
  Auth | ApiKeyLookup,
  never,
  Database | AuthConfig | Mailer | AuditLog | RateLimiter
> = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* AuthConfig;
    const epochs = yield* Effect.serviceOption(ApiKeyEpochs);
    const background = yield* Effect.serviceOption(ApiKeyBackground);
    const database = yield* Database;
    const storage = yield* Effect.serviceOption(SecondaryStorage);
    // Required now so hooks can use them without changing the layer type:
    // email (STV-495) and audit (STV-458).
    const mailer = yield* Mailer;
    const audit = yield* AuditLog;

    const limiter = yield* RateLimiter;

    const auth = makeBetterAuth({
      rateLimitStorage: betterAuthRateLimitStorage(limiter),
      config,
      audit,
      db: database.drizzle,
      secondaryStorage: Option.getOrUndefined(Option.map(storage, toBetterAuthStorage)),
      sendInvitation: (email, org, url) =>
        Effect.runPromise(
          mailer.send(invitationMessage(email, org, url)).pipe(
            Effect.as(true),
            Effect.catchTag("MailerError", () => Effect.succeed(false)),
          ),
        ),
      // Promise callback is the boundary from Better Auth into our Effect service.
      sendMagicLink: (email, url) =>
        Effect.runPromise(
          mailer.send({
            to: email,
            subject: "Sign in to Turborepo Remote Cache",
            text: `Sign in using this link (expires in 10 minutes):\n\n${url}`,
          }),
        ),
    });

    const getSession = (headers: Headers) =>
      callBetterAuth("Auth.getSession", () =>
        auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      ).pipe(Effect.map(Option.fromNullishOr));

    const requireSession = (headers: Headers) =>
      Effect.flatMap(
        getSession(headers),
        Option.match({
          onNone: () => Effect.fail(new Unauthenticated({ reason: "missing" })),
          onSome: Effect.succeed,
        }),
      );

    const requireFreshSession = Effect.fn("Auth.requireFreshSession")(function* (headers: Headers) {
      const session = yield* requireSession(headers);
      const now = new Date(yield* Clock.currentTimeMillis);

      const rows = yield* database.query("Auth.requireFreshSession", (db) =>
        db
          .select({ user: schema.user, session: schema.session })
          .from(schema.session)
          .innerJoin(schema.user, eq(schema.session.userId, schema.user.id))
          .where(
            and(eq(schema.session.token, session.session.token), gt(schema.session.expiresAt, now)),
          )
          .limit(1),
      );

      const live = rows[0];

      if (live === undefined || live.user.banned)
        return yield* new Unauthenticated({ reason: "revoked" });

      return {
        ...session,
        user: { ...session.user, ...live.user },
        session: { ...session.session, ...live.session },
      };
    });

    const keys = makeApiKeys({
      db: database.drizzle,
      auth,
      config,
      audit,
      storage: Option.getOrUndefined(storage),
      epochs: Option.getOrUndefined(epochs),
      background: Option.getOrUndefined(background),
    });

    const handler = (request: Request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        // Aggregate IP guard also covers our custom routes, outside Better Auth's router.
        yield* limiter.check(request.headers.get("cf-connecting-ip") ?? "unknown", {
          name: "auth-ip",
          limit: 60,
          period: 60,
        });

        // Stock routes accept mutable plugin controls; expose only the constrained API.
        if (path.startsWith("/api/auth/api-key/")) return new Response(null, { status: 404 });

        if (!path.startsWith("/api/auth/cache-keys/"))
          return yield* callBetterAuth("Auth.handler", () => auth.handler(request)).pipe(
            Effect.map((response) => {
              if (response.status !== 429) return response;
              // Pinned Better Auth emits X-Retry-After; expose the standard header too.
              const headers = new Headers(response.headers);
              headers.set("Retry-After", headers.get("x-retry-after") ?? "60");
              headers.set("Cache-Control", "no-store");
              return new Response(response.body, { status: response.status, headers });
            }),
          );
        const origin = request.headers.get("origin");

        if (!origin || ![config.baseURL, ...config.trustedOrigins].includes(origin))
          return new Response(null, { status: 403 });

        return yield* Effect.gen(function* () {
          const session = yield* requireFreshSession(request.headers);

          return yield* callBetterAuth("Auth.cacheKeys", () =>
            keys.handle(request, session.user.id),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              Response.json(
                { code: "cache_key_request_failed" },
                {
                  status:
                    error._tag === "Unauthenticated"
                      ? 401
                      : error._tag === "AuthError"
                        ? error.status
                        : 500,
                  headers: { "Cache-Control": "no-store" },
                },
              ),
            ),
          ),
        );
      }).pipe(
        Effect.catchTags({
          RateLimited: (error) =>
            Effect.succeed(
              Response.json(
                { code: "rate_limited" },
                {
                  status: 429,
                  headers: { "Retry-After": String(error.retryAfter), "Cache-Control": "no-store" },
                },
              ),
            ),
          RateLimitUnavailable: () =>
            Effect.succeed(Response.json({ code: "unavailable" }, { status: 503 })),
        }),
      );

    return Context.make(Auth, {
      handler,
      getSession,
      requireSession,
      requireFreshSession,
      revokeSessions: (headers) =>
        Effect.asVoid(
          callBetterAuth("Auth.revokeSessions", () => auth.api.revokeSessions({ headers })),
        ),
    } satisfies AuthService).pipe(
      Context.add(ApiKeyLookup, {
        verify: (key) =>
          Effect.tryPromise({
            try: () => keys.verify(key),
            catch: () => new ApiKeyVerificationError({ cause: "Invalid or unavailable API key" }),
          }),
      }),
    );
  }),
);

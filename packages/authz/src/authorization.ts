import { organizationRoles } from "@repo/auth";
import {
  GrantRepo,
  GrantRepoLive,
  InstanceSettingsRepo,
  InstanceSettingsRepoLive,
  MembershipRepo,
  MembershipRepoLive,
} from "@repo/db";
import { Clock, Context, Effect, Layer, Schema, Option } from "effect";
import {
  decide,
  type Action,
  type Principal,
  type Resource,
  type DecisionFacts,
} from "./decision.ts";

export type { SessionPrincipal } from "./decision.ts";

export type ProjectAction = Action;

export class AuthzError extends Schema.TaggedError<AuthzError>()("AuthzError", {
  message: Schema.String,
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export const AuthorizationCeilings = Context.Reference<
  Parameters<typeof InstanceSettingsRepo.Service.policy>[1]
>("@repo/authz/Ceilings", { defaultValue: () => ({}) });

/** Hosts supply durable audit delivery; request-scoped, never a global callback. */
export class AuthorizationAudit extends Context.Service<
  AuthorizationAudit,
  {
    readonly deny: (
      principal: Principal,
      action: Action,
      resource: Resource,
      reason: string,
    ) => Effect.Effect<void, unknown>;
  }
>()("@repo/authz/AuthorizationAudit") {}

const decodeStatements = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Array(Schema.String)),
);

const permission = (action: Action): readonly [string, string] =>
  action.includes(":") ? [action.split(":")[0]!, action.split(":")[1]!] : ["project", action];

const authorization = Effect.gen(function* () {
  const grants = yield* GrantRepo;
  const members = yield* MembershipRepo;
  const settings = yield* InstanceSettingsRepo;
  const ceilings = yield* AuthorizationCeilings;
  const audit = yield* Effect.serviceOption(AuthorizationAudit);

  const can = Effect.fn("Authorization.can")(
    function* (principal: Principal, action: Action, resource: Resource) {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* settings.resource(resource.orgId, resource.projectId);
      const policy = yield* settings.policy(resource.orgId, ceilings);

      let facts: DecisionFacts = {
        ...state,
        active: false,
        member: false,
        elevated: false,
        instanceRole: "member",
        orgPermission: false,
        projectRole: null,
      };

      if ("userId" in principal) {
        const membership = yield* members.read(
          principal.userId,
          principal.sessionId,
          resource.orgId,
          now,
        );

        const [domain, operation] = permission(action);

        const orgPermission = membership.roles.some((role) => {
          const builtIn = Object.entries(organizationRoles).find(([name]) => name === role)?.[1];

          const statements = builtIn
            ? decodeStatements(builtIn.statements)
            : membership.customPermissions[role];

          return statements?.[domain]?.includes(operation) === true;
        });

        const role = resource.projectId
          ? yield* grants.resolve(resource.orgId, resource.projectId, principal.userId)
          : null;

        facts = { ...facts, ...membership, orgPermission, projectRole: role };
      }

      return decide(principal, action, resource, facts, policy, Math.floor(now / 1000));
    },
    Effect.mapError(
      (cause) =>
        new AuthzError({
          message: "Authorization facts unavailable",
          reason: "unavailable",
          cause,
        }),
    ),
  );

  const requireWith = (evaluate: typeof can) =>
    Effect.fn("Authorization.require")(function* (
      principal: Principal,
      action: Action,
      resource: Resource,
    ) {
      const decision = yield* evaluate(principal, action, resource);

      if (!decision.allowed) {
        if (Option.isSome(audit))
          yield* audit.value.deny(principal, action, resource, decision.reason).pipe(
            Effect.mapError(
              (cause) =>
                new AuthzError({
                  message: "Authorization audit unavailable",
                  reason: "unavailable",
                  cause,
                }),
            ),
          );

        if (Option.isNone(audit))
          return yield* new AuthzError({
            message: "Authorization audit unavailable",
            reason: "unavailable",
          });

        return yield* new AuthzError({ message: "Permission denied", reason: decision.reason });
      }

      return decision;
    });

  return {
    can,
    require: requireWith(can),
    forRequest: Effect.gen(function* () {
      const cache = new Map<string, ReturnType<typeof can>>();

      const cachedCan = (principal: Principal, action: Action, resource: Resource) =>
        Effect.gen(function* () {
          const key = JSON.stringify([principal, action, resource]);
          const existing = cache.get(key);

          if (existing) return yield* existing;
          const memoized = yield* Effect.cached(can(principal, action, resource));
          cache.set(key, memoized);

          return yield* memoized;
        });

      return { can: cachedCan, require: requireWith(cachedCan) };
    }),
  };
});

export class Authorization extends Context.Service<
  Authorization,
  Effect.Success<typeof authorization>
>()("@repo/authz/Authorization") {}

export const AuthorizationLive = Layer.effect(Authorization, authorization);

export const AuthorizationDatabaseLive = AuthorizationLive.pipe(
  Layer.provide(Layer.mergeAll(GrantRepoLive, MembershipRepoLive, InstanceSettingsRepoLive)),
);

/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- HTTP integration tests at the Bun boundary. */
import { expect, test } from "bun:test";
import { Auth } from "@repo/auth";
import { AuthTest } from "@repo/auth/testing";
import { Database, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import {
  Project,
  ProjectList,
  TrustPolicy,
  TrustPolicyList,
  TestTrustPoliciesResponse,
} from "@repo/api-spec";
import { Projects } from "@repo/projects";
import { ProjectsTest } from "@repo/projects/testing";
import { Effect, Layer, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { isProjectsPath, projectsRoute } from "../src/projects-route.ts";

const decodeProject = Schema.decodeUnknownSync(Project);
const decodePage = Schema.decodeUnknownSync(ProjectList);
const decodeTrustPolicy = Schema.decodeUnknownSync(TrustPolicy);
const decodeTrustPolicyList = Schema.decodeUnknownSync(TrustPolicyList);

const cookie = async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("auth-test-secret-0123456789abcdef0123456789"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("token"));

  return `better-auth.session_token=${encodeURIComponent(`token.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
};

type Serve = (
  path: string,
  options?: {
    method?: string;
    body?: object;
    rawBody?: string;
    anonymous?: boolean;
    origin?: string;
  },
) => Effect.Effect<Response, unknown>;

const scenario = (task: (serve: Serve) => Effect.Effect<void, unknown, Database>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const auth = yield* Auth;
      const projects = yield* Projects;
      const now = new Date("2026-01-01T00:00:00Z");
      yield* db.batch((db) => [
        db.insert(schema.user).values({
          id: "u",
          name: "User",
          email: "u@example.com",
          role: "member",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.session).values({
          id: "s",
          userId: "u",
          token: "token",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          createdAt: now,
          updatedAt: now,
        }),
        db
          .insert(schema.organization)
          .values({ id: "org", slug: "org", name: "Org", createdAt: now }),
        db
          .insert(schema.member)
          .values({ id: "m", userId: "u", organizationId: "org", role: "owner", createdAt: now }),
      ]);
      const signed = yield* Effect.promise(cookie);

      const handler = projectsRoute(
        Layer.mergeAll(Layer.succeed(Auth, auth), Layer.succeed(Projects, projects)),
      );

      const serve: Serve = (path, options = {}) =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`http://localhost${path}`, {
                method: options.method ?? "GET",
                headers: {
                  cookie: options.anonymous ? "" : signed,
                  origin: options.origin ?? "http://localhost",
                  "content-type": "application/json",
                },
                body: options.rawBody ?? (options.body ? JSON.stringify(options.body) : undefined),
              }),
            ),
          ),
          Effect.provideService(CanonicalOrigin, "http://localhost"),
          Effect.map(HttpServerResponse.toWeb),
        );

      yield* task(serve);
    }).pipe(Effect.provide(Layer.mergeAll(AuthTest, ProjectsTest))),
  );

test("project routes match the shared contract and serialize project lifecycle responses", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      expect(isProjectsPath("/orgs/org/projects")).toBe(true);
      expect(isProjectsPath("/projects/p")).toBe(true);
      expect(isProjectsPath("/projects/p/grants")).toBe(true);

      const createdResponse = yield* serve("/orgs/org/projects", {
        method: "POST",
        body: { slug: "cache", name: "Cache" },
      });

      expect(createdResponse.status).toBe(201);
      expect(createdResponse.headers.get("cache-control")).toBe("no-store");
      const created = decodeProject(yield* Effect.promise(() => createdResponse.json()));
      const pageResponse = yield* serve("/orgs/org/projects?limit=1");
      expect(decodePage(yield* Effect.promise(() => pageResponse.json())).items[0]?.id).toBe(
        created.id,
      );

      const archived = yield* serve(`/projects/${created.id}`, {
        method: "PATCH",
        body: { archived: true },
      });

      expect(archived.status).toBe(200);
      expect(decodeProject(yield* Effect.promise(() => archived.json())).archivedAt).not.toBeNull();
      expect(
        (yield* serve(`/projects/${created.id}`, {
          method: "DELETE",
          body: { confirmation: "wrong" },
        })).status,
      ).toBe(400);
      expect(
        (yield* serve(`/projects/${created.id}`, {
          method: "DELETE",
          body: { confirmation: created.id },
        })).status,
      ).toBe(202);
      expect((yield* serve(`/projects/${created.id}`)).status).toBe(403);
    }),
  ));

test("HTTP boundary rejects missing sessions, CSRF, malformed JSON, invalid limits and oversized bodies", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      expect((yield* serve("/orgs/org/projects", { anonymous: true })).status).toBe(401);
      expect(
        (yield* serve("/orgs/org/projects", {
          method: "POST",
          origin: "https://attacker.example",
          body: { slug: "cache", name: "Cache" },
        })).status,
      ).toBe(403);
      expect((yield* serve("/orgs/org/projects", { method: "POST", rawBody: "{" })).status).toBe(
        400,
      );
      expect(
        (yield* serve("/orgs/org/projects", {
          method: "POST",
          body: { slug: "../escape", name: "Cache" },
        })).status,
      ).toBe(400);
      expect((yield* serve("/orgs/org/projects?limit=101")).status).toBe(400);
      expect((yield* serve("/orgs/org/projects?limit=0")).status).toBe(400);
      expect(
        (yield* serve("/orgs/org/projects", {
          method: "POST",
          body: { slug: "cache", name: "Cache", padding: "x".repeat(20_000) },
        })).status,
      ).toBe(400);
      expect((yield* serve("/orgs/org/projects", { method: "PUT", body: {} })).status).toBe(405);
      const page = yield* serve("/orgs/org/projects");
      expect(decodePage(yield* Effect.promise(() => page.json())).items).toEqual([]);
    }),
  ));

test("grant HTTP routes add, list and remove audited same-org grants", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const response = yield* serve("/orgs/org/projects", {
        method: "POST",
        body: { slug: "grants", name: "Grants" },
      });

      const project = decodeProject(yield* Effect.promise(() => response.json()));
      const path = `/projects/${project.id}/grants`;
      expect(
        (yield* serve(path, {
          method: "POST",
          body: { principalType: "user", principalId: "u", role: "cache:write" },
        })).status,
      ).toBe(201);
      const list = yield* serve(path);
      const grants = yield* Effect.promise(() => list.json());
      expect(grants).toMatchObject([
        { projectId: project.id, principalId: "u", role: "cache:write" },
      ]);
      expect((yield* serve(`${path}/user/u`, { method: "DELETE" })).status).toBe(204);
      const empty = yield* serve(path);
      expect(yield* Effect.promise(() => empty.json())).toEqual([]);
    }),
  ));

test("trust policy routes enforce contract, session, origin, validation and project-scoped IDs", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const response = yield* serve("/orgs/org/projects", {
        method: "POST",
        body: { slug: "cache", name: "Cache" },
      });

      const project = decodeProject(yield* Effect.promise(() => response.json()));
      const path = `/projects/${project.id}/trust-policies`;
      expect(isProjectsPath(path)).toBe(true);

      const body = {
        provider: "github",
        enabled: true,
        issuer: "https://token.actions.githubusercontent.com",
        claims: {
          aud: ["cache"],
          repository: ["org/repo"],
          repository_id: ["1"],
          repository_owner_id: ["2"],
          event_name: ["push"],
        },
        scope: "read write",
        ttlSeconds: 600,
      };

      expect((yield* serve(path, { anonymous: true })).status).toBe(401);
      expect(
        (yield* serve(path, { method: "POST", origin: "https://attacker.example", body })).status,
      ).toBe(403);
      expect((yield* serve(path, { method: "POST", body: { ...body, claims: {} } })).status).toBe(
        400,
      );
      const created = yield* serve(path, { method: "POST", body });
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");

      const policy = decodeTrustPolicy(yield* Effect.promise(() => created.json()));

      const listed = yield* serve(path);
      expect(decodeTrustPolicyList(yield* Effect.promise(() => listed.json()))).toHaveLength(1);
      expect(
        (yield* serve(`${path}/${policy.id}`, { method: "PUT", body: { ...body, enabled: false } }))
          .status,
      ).toBe(200);
      expect((yield* serve(`${path}/missing`, { method: "PUT", body })).status).toBe(404);
      expect((yield* serve(path, { method: "PATCH", body })).status).toBe(405);
      expect((yield* serve(path, { method: "POST", rawBody: "{" })).status).toBe(400);
      expect(
        (yield* serve(path, {
          method: "POST",
          rawBody: JSON.stringify({ ...body, label: "x".repeat(17000) }),
        })).status,
      ).toBe(400);
      expect((yield* serve(`${path}/${policy.id}`, { method: "DELETE" })).status).toBe(204);
      expect((yield* serve(`${path}/${policy.id}`, { method: "DELETE" })).status).toBe(404);
    }),
  ));

test("policy tester is an admin-only CSRF-protected simulation with claim explanations and no mutation", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const created = yield* serve("/orgs/org/projects", {
        method: "POST",
        body: { slug: "tester", name: "Tester" },
      });
      const project = decodeProject(yield* Effect.promise(() => created.json()));
      const path = `/projects/${project.id}/trust-policies`;
      const policy = {
        provider: "github",
        enabled: true,
        issuer: "https://token.actions.githubusercontent.com",
        scope: "read write",
        ttlSeconds: 800,
        claims: {
          aud: ["cache"],
          repository_id: ["1"],
          repository_owner_id: ["2"],
          event_name: ["push"],
        },
        refPatterns: ["refs/heads/*"],
      };
      expect(
        (yield* serve(path, {
          method: "POST",
          body: { ...policy, claims: { aud: ["cache"], repository: ["org/repo"] } },
        })).status,
      ).toBe(400);
      const saved = yield* serve(path, { method: "POST", body: policy });
      expect(saved.status).toBe(201);
      const stored = decodeTrustPolicy(yield* Effect.promise(() => saved.json()));
      expect(stored.warnings.map((warning) => warning.code)).toContain("broad_write_refs");
      const body = {
        claims: {
          iss: policy.issuer,
          aud: "cache",
          repository_id: "1",
          repository_owner_id: "2",
          event_name: "push",
          ref: "refs/heads/main",
        },
      };
      expect((yield* serve(`${path}/test`, { method: "POST", anonymous: true, body })).status).toBe(
        401,
      );
      expect(
        (yield* serve(`${path}/test`, { method: "POST", origin: "https://attacker.example", body }))
          .status,
      ).toBe(403);
      expect((yield* serve(`${path}/test`, { method: "POST", body: {} })).status).toBe(400);
      expect(
        (yield* serve(`${path}/test`, { method: "POST", rawBody: "x".repeat(16_385) })).status,
      ).toBe(400);
      expect((yield* serve(`${path}/test`)).status).toBe(405);
      const response = yield* serve(`${path}/test`, { method: "POST", body });
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = Schema.decodeUnknownSync(TestTrustPoliciesResponse)(
        yield* Effect.promise(() => response.json()),
      );
      expect(result).toMatchObject({
        simulation: true,
        matched: true,
        scope: "read write",
        policyIds: [stored.id],
      });
      expect(result.policies[0]?.checks.every((check) => check.matched)).toBe(true);
      const mismatch = yield* serve(`${path}/test`, {
        method: "POST",
        body: { claims: { ...body.claims, repository_id: "3" } },
      });
      expect(
        Schema.decodeUnknownSync(TestTrustPoliciesResponse)(
          yield* Effect.promise(() => mismatch.json()),
        ),
      ).toMatchObject({ matched: false, policies: [{ failedClaims: ["repository_id"] }] });
      const listed = yield* serve(path);
      expect(decodeTrustPolicyList(yield* Effect.promise(() => listed.json()))).toHaveLength(1);
      const db = yield* Database;
      yield* db.query("test.demoteTester", (db) =>
        db.update(schema.member).set({ role: "member" }),
      );
      expect((yield* serve(`${path}/test`, { method: "POST", body })).status).toBe(403);
    }),
  ));

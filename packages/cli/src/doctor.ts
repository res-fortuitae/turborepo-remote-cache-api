import { ClientConfig, CiProvider } from "@repo/client-core";
import { HealthReport, SelfTestReport } from "@repo/shared";
import { Effect, Schema } from "effect";
import { makeAuthRuntime } from "./auth.ts";
import { sessionRequest } from "./account.ts";
import { safeServer } from "./device.ts";

/** Only an allowlist of unverified diagnostic claims is emitted, never assertion/signature bytes. */
export const diagnosticClaims = (token: string | undefined) => {
  if (!token || token.length > 16384) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    if (!value || typeof value !== "object") return undefined;
    const allowed = new Set([
      "iss",
      "sub",
      "aud",
      "iat",
      "nbf",
      "exp",
      "repository",
      "repository_id",
      "repository_owner_id",
      "job_workflow_ref",
      "environment",
      "namespace_id",
      "oidc.circleci.com/project-id",
      "oidc.circleci.com/vcs-origin",
      "oidc.circleci.com/vcs-ref",
      "workspaceUuid",
      "repositoryUuid",
      "branchName",
      "ref",
      "event_name",
      "project_id",
      "pipeline_source",
    ]);
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, value]) =>
          allowed.has(key) &&
          (typeof value === "string" ||
            typeof value === "number" ||
            (Array.isArray(value) && value.every((v) => typeof v === "string"))),
      ),
    );
  } catch {
    return undefined;
  }
};
export const localWarnings = (
  env: Record<string, string | undefined>,
  claims?: Record<string, unknown>,
) => {
  const warnings: string[] = [];
  if (
    env.GITHUB_ACTIONS === "true" &&
    !(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  )
    warnings.push("GitHub OIDC unavailable: grant id-token: write; fork PRs may restrict it.");
  if (env.GITHUB_EVENT_NAME === "pull_request_target")
    warnings.push(
      "pull_request_target uses privileged base-repository context. Never run untrusted checkout with write credentials.",
    );
  if (
    env.GITHUB_EVENT_NAME === "pull_request" ||
    (env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID &&
      env.CI_PROJECT_ID !== env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID)
  )
    warnings.push(
      "PR/fork context detected. Use read-only cache policy and check the verified repository identity.",
    );
  if (
    env.RUNNER_ENVIRONMENT === "self-hosted" ||
    /self.hosted/i.test(env.RUNNER_LABELS ?? "") ||
    (env.RUNNER_NAME && env.RUNNER_ENVIRONMENT !== "github-hosted") ||
    env.BUILDKITE_AGENT_NAME
  )
    warnings.push(
      "Possibly persistent self-hosted runner. Use ephemeral runners, isolate trust levels, and remove workspace credentials between jobs.",
    );
  if (env.GITHUB_WORKSPACE && env.RUNNER_TEMP && !env.TCACHE_EPHEMERAL_RUNNER)
    warnings.push(
      "Workspace reuse cannot be ruled out. Confirm the runner/workspace is destroyed after each job.",
    );
  if (claims && typeof claims.exp === "number" && claims.exp * 1000 <= Date.now())
    warnings.push("OIDC assertion is expired.");
  if (claims && typeof claims.nbf === "number" && claims.nbf * 1000 > Date.now() + 30000)
    warnings.push("OIDC assertion is not yet valid; check runner clock.");
  return warnings;
};
export const runDoctor = async (options: {
  server: boolean;
  api: string;
  url: string;
  json: boolean;
  policy: boolean;
  project: string;
}) => {
  const runtime = makeAuthRuntime({
    api: options.url || options.api || undefined,
    project: options.project || undefined,
    strict: true,
    boundTokens: false,
  });
  let resolved: {
    api?: string;
    team?: string;
    project?: string;
    provider?: string;
    configuration?: string;
  } = {};
  try {
    resolved = await runtime.runPromise(
      Effect.gen(function* () {
        const config = yield* ClientConfig;
        const provider = yield* CiProvider;
        return {
          api: config.api,
          team: config.team,
          project: config.project,
          provider: (yield* provider.detect) ?? "developer-or-api-key",
        };
      }),
    );
  } catch {
    resolved.configuration =
      "Incomplete config: set TCACHE_API/TEAM/PROJECT, pass flags, or link the repository.";
  } finally {
    await runtime.dispose();
  }
  const env = Bun.env;
  const raw =
    env.CACHE_ID_TOKEN ??
    env.CIRCLE_OIDC_TOKEN_V2 ??
    env.BITBUCKET_STEP_OIDC_TOKEN ??
    env.TCACHE_ID_TOKEN;
  const claims = diagnosticClaims(raw);
  const warnings = localWarnings(env, claims);
  const sources = Object.fromEntries(
    ["api", "team", "project"].map((key) => [
      key,
      (key === "api" && (options.api || options.url)) || (key === "project" && options.project)
        ? "flag"
        : env[`TCACHE_${key.toUpperCase()}`]
          ? "environment"
          : ".turbo-cache.json/default",
    ]),
  );
  let connectivity: { ok: boolean; latencyMs: number; clockSkewMs?: number } | undefined;
  let health: typeof HealthReport.Type | undefined;
  let selftest: typeof SelfTestReport.Type | undefined;
  let policy: unknown;
  const server = options.url || options.api || resolved.api || env.TCACHE_API || env.TURBO_API;
  if (server) {
    const api = safeServer(server);
    const start = Date.now();
    try {
      const response = await fetch(`${api}/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const date = Date.parse(response.headers.get("date") ?? "");
      health = Schema.decodeUnknownSync(HealthReport)(await response.json());
      connectivity = {
        ok: response.ok && health.healthy,
        latencyMs: Date.now() - start,
        ...(Number.isFinite(date) ? { clockSkewMs: date - (start + Date.now()) / 2 } : {}),
      };
      if (connectivity.clockSkewMs && Math.abs(connectivity.clockSkewMs) > 30000)
        warnings.push("Runner/server clock differs by over 30 seconds.");
    } catch {
      connectivity = { ok: false, latencyMs: Date.now() - start };
    }
    if (options.server) {
      try {
        selftest = Schema.decodeUnknownSync(SelfTestReport)(
          await (await sessionRequest("/api/instance/selftest", "POST", {}, api)).json(),
        );
      } catch {
        warnings.push(
          "Admin self-test unavailable. Sign in as an instance admin; check step-up policy and server health.",
        );
      }
    }
    if ((options.policy || !options.server) && resolved.project && claims) {
      try {
        policy = await (
          await sessionRequest(
            `/projects/${encodeURIComponent(resolved.project)}/trust-policies/test`,
            "POST",
            { claims },
            api,
          )
        ).json();
      } catch {
        warnings.push(
          "Policy dry run unavailable. Ask a project admin to test these unverified claims and inspect the audit log.",
        );
      }
    }
  }
  const report = {
    config: resolved,
    sources,
    claims,
    claimsVerified: false,
    warnings,
    connectivity,
    health,
    selftest,
    policy,
    auditLog: server ? `${safeServer(server)}/#audit` : undefined,
  };
  console.log(
    options.json
      ? JSON.stringify(report, null, 2)
      : [
          `Config: ${JSON.stringify(resolved)}\nSources: ${JSON.stringify(sources)}`,
          `Unverified claims: ${JSON.stringify(claims ?? {})}`,
          `Connectivity: ${connectivity?.ok ? "ok" : "unavailable"}`,
          ...(selftest?.steps.map(
            (step) => `${step.name}: ${step.ok ? "ok" : "failed"} (${step.latencyMs} ms)`,
          ) ?? []),
          ...warnings.map((warning) => `Warning: ${warning}`),
          options.policy
            ? `Policy dry run: ${JSON.stringify(policy ?? "unavailable")}`
            : "Use --policy to request an authorized project policy dry run.",
        ].join("\n"),
  );
  if (
    !connectivity?.ok ||
    (options.server && !selftest?.ok) ||
    (!options.server && resolved.configuration)
  )
    process.exitCode = 1;
};

import { expect, test } from "bun:test";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import {
  detectCapabilities,
  resolveCapabilities,
  workersPlanFromSubscriptions,
  type CapabilityInputs,
} from "./capabilities.ts";

const input: CapabilityInputs = { dev: false, catalogToken: true, features: {} };

test("billing products and canceled Workers subscriptions do not grant Workers Paid", () => {
  expect(
    workersPlanFromSubscriptions([
      { state: "Paid", ratePlan: { id: "business", publicName: "Business" } },
    ]),
  ).toBe("unknown");
  expect(
    workersPlanFromSubscriptions([
      { state: "Cancelled", ratePlan: { publicName: "Workers Paid" } },
    ]),
  ).toBe("unknown");
  expect(
    workersPlanFromSubscriptions([{ state: "Paid", ratePlan: { publicName: "Workers Paid" } }]),
  ).toBe("paid");
  expect(
    workersPlanFromSubscriptions([{ state: "Provisioned", ratePlan: { id: "workers_standard" } }]),
  ).toBe("paid");
  expect(
    workersPlanFromSubscriptions([{ state: "Provisioned", ratePlan: { id: "workers_free" } }]),
  ).toBe("free");
});

test.each(["free", "unknown"] as const)(
  "%s gets lite analytics and durable D1 audit retention",
  (workersPlan) => {
    const report = resolveCapabilities(input, { workersPlan, zonePlan: "pro" });
    expect(report.auditHistory.enabled).toBe(false);
    expect(report.auditRetentionDays).toBe(365);
    expect(report.analyticsMode).toBe("lite");
    expect(report.directUploads.enabled).toBe(false);
    expect(report.emailSending.enabled).toBe(false);
  },
);

test("Workers Paid does not imply a paid zone or an installed integration", () => {
  const report = resolveCapabilities(input, { workersPlan: "paid", zonePlan: "free" });
  expect(report.auditHistory.enabled).toBe(true);
  expect(report.auditRetentionDays).toBe(90);
  expect(report.directUploads.enabled).toBe(false);
  expect(report.emailSending.reason).toContain("No email sender configured");
  expect(report.analytics.reason).toContain("STV-462");
});

test.each(["business", "enterprise"] as const)("%s does not imply Workers Paid", (zonePlan) => {
  const report = resolveCapabilities(input, { workersPlan: "free", zonePlan });
  expect(report.directUploads.enabled).toBe(true);
  expect(report.auditHistory.enabled).toBe(false);
});

test.each(["eu", "fedramp"])("%s overrides Workers Paid for Basin", (jurisdiction) => {
  const report = resolveCapabilities(
    { ...input, jurisdiction },
    { workersPlan: "paid", zonePlan: "business" },
  );

  expect(report.auditHistory.enabled).toBe(false);
  expect(report.auditHistory.reason).toContain("jurisdiction");
});

test("flags beat detected entitlements and select disabled analytics", () => {
  const report = resolveCapabilities(
    {
      ...input,
      features: {
        emailSending: false,
        analytics: false,
        auditHistory: false,
        directUploads: false,
      },
    },
    { workersPlan: "paid", zonePlan: "enterprise" },
  );

  for (const feature of [
    report.emailSending,
    report.analytics,
    report.auditHistory,
    report.directUploads,
  ]) {
    expect(feature.enabled).toBe(false);
    expect(feature.reason).toContain("Disabled");
  }

  expect(report.analyticsMode).toBe("disabled");
});

test("missing credentials and explicit Workers assertions are conservative and explainable", () => {
  const report = resolveCapabilities(
    { ...input, catalogToken: false, workersPlan: "paid" },
    { workersPlan: "unknown", zonePlan: "none", warnings: ["Probe denied"] },
  );

  expect(report.auditHistory.enabled).toBe(false);
  expect(report.auditHistory.reason).toContain("TOKEN");
  expect(report.warnings).toEqual(["Probe denied"]);
});

const local = Test.make({ providers: Cloudflare.providers(), dev: true });

local.test.provider("local detection never requests an account or cloud credentials", () =>
  Effect.gen(function* () {
    const report = yield* detectCapabilities({ ...input, dev: true, workersPlan: "paid" });
    expect(report.workersPlan).toBe("local");
    expect(report.auditHistory.enabled).toBe(false);
    expect(report.directUploads.enabled).toBe(false);
  }),
);

test("email sending requires both paid entitlement and explicit sender configuration", () => {
  expect(
    resolveCapabilities(
      { ...input, emailConfigured: true },
      { workersPlan: "paid", zonePlan: "free" },
    ).emailSending.enabled,
  ).toBe(true);
  expect(
    resolveCapabilities(
      { ...input, emailConfigured: true },
      { workersPlan: "free", zonePlan: "business" },
    ).emailSending.enabled,
  ).toBe(false);
});

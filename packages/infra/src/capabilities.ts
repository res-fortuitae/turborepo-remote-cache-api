import type { CapabilityReport } from "@repo/api-spec";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CapabilityInputs {
  readonly dev: boolean;
  readonly domain?: string | undefined;
  readonly jurisdiction?: string | undefined;
  readonly workersPlan?: "free" | "paid" | undefined;
  readonly catalogToken: boolean;
  readonly features: {
    readonly emailSending?: boolean;
    readonly analytics?: boolean;
    readonly auditHistory?: boolean;
    readonly directUploads?: boolean;
  };
}

type WorkersPlan = CapabilityReport["workersPlan"];

type ZonePlan = CapabilityReport["zonePlan"];

/** Unknown billing products never establish an entitlement. Zone plans are unrelated. */
export const workersPlanFromSubscriptions = (
  subscriptions: readonly {
    readonly state?: string | null;
    readonly ratePlan?: {
      readonly id?: string | null;
      readonly publicName?: string | null;
    } | null;
  }[],
): WorkersPlan => {
  const active = subscriptions.filter((s) => s.state === "Paid" || s.state === "Provisioned");

  if (
    active.some(
      (s) =>
        /^(workers paid|workers standard|workers bundled|workers unbound)$/i.test(
          s.ratePlan?.publicName ?? "",
        ) || /^workers_(paid|standard|bundled|unbound)$/.test(s.ratePlan?.id ?? ""),
    )
  )
    return "paid";

  if (
    active.some(
      (s) =>
        /^workers free$/i.test(s.ratePlan?.publicName ?? "") || s.ratePlan?.id === "workers_free",
    )
  )
    return "free";

  return "unknown";
};

export const resolveCapabilities = (
  input: CapabilityInputs,
  detected: {
    readonly workersPlan: WorkersPlan;
    readonly zonePlan: ZonePlan;
    readonly warnings?: readonly string[];
  },
): CapabilityReport => {
  const workersPlan = input.dev ? "local" : (input.workersPlan ?? detected.workersPlan);
  const paid = workersPlan === "paid";

  const restriction = input.dev
    ? "Cloud integrations are unavailable in local development."
    : !paid
      ? `Workers Paid is required; detected plan: ${workersPlan}.`
      : input.jurisdiction && input.jurisdiction !== "default"
        ? "Basin is unavailable in this jurisdiction."
        : undefined;

  const auditReason =
    input.features.auditHistory === false
      ? "Disabled in deploy.config.ts."
      : (restriction ??
        (!input.catalogToken ? "BASIN_CATALOG_TOKEN is not configured." : undefined));

  return {
    schemaVersion: 1,
    workersPlan,
    zonePlan: input.dev ? "none" : detected.zonePlan,
    emailSending: {
      enabled: false,
      reason:
        input.features.emailSending === false
          ? "Disabled in deploy.config.ts."
          : !paid
            ? `Workers Paid is required; detected plan: ${workersPlan}.`
            : "Email Sending integration and domain verification are pending STV-495.",
      fallback:
        "No email delivery. Dashboard invite links are pending STV-495; use GitHub sign-in.",
      upgrade:
        "Workers Paid and Email Service enabled on a verified domain unlock transactional email (STV-495).",
    },
    analytics: {
      enabled: false,
      reason:
        input.features.analytics === false
          ? "Disabled in deploy.config.ts."
          : (restriction ?? "Basin analytics integration is pending STV-462–465."),
      fallback:
        input.features.analytics === false
          ? "Analytics disabled."
          : "Lite analytics: hourly project counters in D1; no Iceberg history or drill-downs.",
      upgrade: "Workers Paid unlocks Basin analytics when STV-462–465 is installed.",
    },
    auditHistory: {
      enabled: auditReason === undefined,
      reason: auditReason ?? "Workers Paid and Basin Catalog token are configured.",
      fallback: "Audit events stay in D1; unexported events are never pruned.",
      upgrade:
        "Workers Paid and a Basin Catalog token unlock Iceberg audit history in the default jurisdiction.",
    },
    directUploads: {
      enabled:
        !input.dev &&
        input.features.directUploads !== false &&
        (detected.zonePlan === "business" || detected.zonePlan === "enterprise"),
      reason:
        input.features.directUploads === false
          ? "Disabled in deploy.config.ts."
          : input.dev
            ? "Local development uses the conservative 100 MB limit."
            : detected.zonePlan === "business" || detected.zonePlan === "enterprise"
              ? "The custom domain is on a Business or Enterprise zone; the zone upload setting still applies."
              : "Uploads over 100 MB require a Business or Enterprise zone.",
      fallback: "100 MB request ceiling. Proxy multipart uploads are pending STV-492.",
      upgrade:
        "Business or Enterprise on the serving zone unlocks requests over 100 MB, subject to its upload setting.",
    },
    analyticsMode: input.features.analytics === false ? "disabled" : "lite",
    auditRetentionDays: auditReason === undefined ? 90 : 365,
    warnings: [...(detected.warnings ?? [])],
  };
};

/** Read-only probes at deployment, using Alchemy's selected account and credentials. */
export const detectCapabilities = Effect.fn("Infra.detectCapabilities")(function* (
  input: CapabilityInputs,
) {
  if (input.dev) return resolveCapabilities(input, { workersPlan: "local", zonePlan: "none" });
  const environment = yield* CloudflareEnvironment;
  const { accountId } = yield* environment;
  const warnings: string[] = [];

  const workersPlan =
    input.workersPlan ??
    (yield* accounts.getSubscription.pages({ accountId }).pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        workersPlanFromSubscriptions(Array.from(pages).flatMap((p) => p.result)),
      ),
      Effect.catch(() => {
        warnings.push(
          "Workers plan detection failed. Grant account billing read access or set workersPlan explicitly; paid features remain disabled.",
        );

        return Effect.succeed("unknown" as const);
      }),
    ));

  let zonePlan: ZonePlan = input.domain ? "unknown" : "none";

  if (input.domain) {
    const domain = input.domain;
    zonePlan = yield* zones.listZones.pages({ account: { id: accountId } }).pipe(
      Stream.runCollect,
      Effect.map((pages): ZonePlan => {
        const zone = Array.from(pages)
          .flatMap((p) => p.result)
          .filter((z) => domain === z.name || domain.endsWith(`.${z.name}`))
          .sort((a, b) => b.name.length - a.name.length)[0];

        const plan = zone?.plan.legacyId;

        return plan === "free" || plan === "pro" || plan === "business" || plan === "enterprise"
          ? plan
          : "unknown";
      }),
      Effect.catch(() => {
        warnings.push(
          "Zone plan detection failed. Grant Zone Read permission; the conservative upload limit remains active.",
        );

        return Effect.succeed("unknown" as const);
      }),
    );
  }

  return resolveCapabilities(input, { workersPlan, zonePlan, warnings });
});

import { CapabilityReport } from "@repo/shared";
import * as Schema from "effect/Schema";

const decodeCapabilities = Schema.decodeUnknownSync(CapabilityReport);

export interface DoctorServerOptions {
  readonly server: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/** Shared by the command and future doctor checks; validates server version and payload. */
export const doctorServer = async (options: DoctorServerOptions): Promise<CapabilityReport> => {
  const origin = new URL(options.server);

  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
    throw new Error("Server must be an origin without credentials, a path, or a query");

  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  )
    throw new Error("Server must use HTTPS (HTTP is allowed on loopback)");

  const response = await (options.fetch ?? fetch)(new URL("/api/instance/capabilities", origin), {
    headers: { authorization: `Bearer ${options.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`Server capability check failed (HTTP ${response.status})`);

  return decodeCapabilities(await response.json());
};

export const formatCapabilities = (report: CapabilityReport): string =>
  [
    `Workers: ${report.workersPlan}; zone: ${report.zonePlan}`,
    ...(["emailSending", "analytics", "auditHistory", "directUploads"] as const).map((key) => {
      const feature = report[key];

      return `${key}: ${feature.enabled ? "on" : "off"}: ${feature.reason}\n  Fallback: ${feature.fallback}\n  Unlock: ${feature.upgrade}`;
    }),
    ...report.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");

import type { MailMessage } from "./mailer.ts";

export const invitationMessage = (to: string, organization: string, url: string): MailMessage => ({
  to,
  subject: "Organization invitation",
  text: `You have been invited to ${organization}. Sign in and accept your invitation before it expires:\n\n${url}`,
});

export type AlertKind =
  | "device-login"
  | "api-key-expiring"
  | "api-key-unused"
  | "anomaly"
  | "quota"
  | "audit-integrity";
const titles: Record<AlertKind, string> = {
  "device-login": "Device login approval",
  "api-key-expiring": "API key expiring",
  "api-key-unused": "Unused API key digest",
  anomaly: "Cache security alert",
  quota: "Storage quota warning",
  "audit-integrity": "Audit integrity failure",
};
export const alertMessage = (
  to: string,
  kind: AlertKind,
  detail: string,
  consoleURL: string,
): MailMessage => ({
  to,
  subject: titles[kind],
  text: `${detail}\n\nOpen your instance console:\n${consoleURL}`,
});

export { Mailer, MailerError, MailerNoop, MailerDisabled, MailMessage } from "./mailer.ts";

export type { MailerService } from "./mailer.ts";
export { EmailSend, MailerLive, MailerConsole } from "./mailer.ts";
export { invitationMessage, alertMessage, type AlertKind } from "./templates.ts";
export { MailerTest, Mailbox } from "./testing.ts";
export { Alerts, AlertsLive, NotificationSink, type Alert } from "./alerts.ts";

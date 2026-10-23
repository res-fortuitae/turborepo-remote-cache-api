import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const MailMessage = Schema.Struct({
  to: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  html: Schema.optional(Schema.String),
});

export type MailMessage = typeof MailMessage.Type;

export class MailerError extends Schema.TaggedError<MailerError>()("MailerError", {
  cause: Schema.Unknown,
}) {}

export interface MailerService {
  readonly send: (message: MailMessage) => Effect.Effect<void, MailerError>;
}

export class Mailer extends Context.Service<Mailer, MailerService>()("@repo/mailer/Mailer") {}

/** Drops every message. Stands in until STV-495 adds Cloudflare Email Service. */
export const MailerNoop: Layer.Layer<Mailer> = Layer.succeed(Mailer, {
  send: () => Effect.void,
});

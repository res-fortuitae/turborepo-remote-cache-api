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

/** Production fallback fails explicitly so login never claims an undelivered email was sent. */
export const MailerDisabled: Layer.Layer<Mailer> = Layer.succeed(Mailer, {
  send: () =>
    Effect.fail(
      new MailerError({
        cause: "Email sending is unavailable on this instance. Use GitHub sign-in.",
      }),
    ),
});

/** The composition root adapts the platform binding to this Effect-only port. */
export class EmailSend extends Context.Service<
  EmailSend,
  {
    readonly from: string;
    readonly send: (
      message: MailMessage & { readonly from: string },
    ) => Effect.Effect<unknown, unknown>;
  }
>()("@repo/mailer/EmailSend") {}

export const MailerLive: Layer.Layer<Mailer, never, EmailSend> = Layer.effect(
  Mailer,
  Effect.gen(function* () {
    const binding = yield* EmailSend;
    return {
      send: (message: MailMessage) =>
        binding.send({ ...message, from: binding.from }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new MailerError({ cause })),
          Effect.tap(() =>
            Effect.logInfo("Transactional email accepted", { subject: message.subject }),
          ),
          Effect.tapError(() =>
            Effect.logWarning("Transactional email failed", { subject: message.subject }),
          ),
        ),
    };
  }),
);

/** Local development only. Delivery links are deliberately visible to the developer. */
export const MailerConsole: Layer.Layer<Mailer> = Layer.succeed(Mailer, {
  send: (message) => Effect.logInfo("Local transactional email", message),
});

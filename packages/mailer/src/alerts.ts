import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Mailer, MailerError } from "./mailer.ts";
import { alertMessage, type AlertKind } from "./templates.ts";

export interface Alert {
  readonly id: string;
  readonly userId: string;
  readonly kind: AlertKind;
  readonly detail: string;
  readonly to: string;
  readonly consoleURL: string;
}
/** Persist first, then optionally forward to the operator's webhook. No mail body in audit. */
export class NotificationSink extends Context.Service<
  NotificationSink,
  {
    readonly persist: (alert: Alert) => Effect.Effect<void, MailerError>;
    readonly webhook?: (alert: Alert) => Effect.Effect<void, MailerError>;
  }
>()("@repo/mailer/NotificationSink") {}
export class Alerts extends Context.Service<
  Alerts,
  {
    readonly notify: (alert: Alert) => Effect.Effect<void, MailerError>;
  }
>()("@repo/mailer/Alerts") {}

export const AlertsLive = Layer.effect(
  Alerts,
  Effect.gen(function* () {
    const sink = yield* NotificationSink;
    const mailer = yield* Mailer;
    return {
      notify: (alert: Alert) =>
        Effect.gen(function* () {
          yield* sink.persist(alert);
          yield* mailer
            .send(alertMessage(alert.to, alert.kind, alert.detail, alert.consoleURL))
            .pipe(
              Effect.catchTag("MailerError", () =>
                Effect.logInfo("Alert retained in console", { id: alert.id, kind: alert.kind }),
              ),
            );
          if (sink.webhook) yield* sink.webhook(alert);
        }),
    };
  }),
);

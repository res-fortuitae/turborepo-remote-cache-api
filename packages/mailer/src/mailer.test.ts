/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary. */
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { EmailSend, Mailer, MailerDisabled, MailerError, MailerLive } from "./mailer.ts";
import { Mailbox, MailerTest } from "./testing.ts";
import { alertMessage, invitationMessage } from "./templates.ts";

test("live mailer propagates delivery failures", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const mailer = yield* Mailer;
      return yield* Effect.flip(
        mailer.send(invitationMessage("a@example.com", "Web", "https://cache.test/#invitation")),
      );
    }).pipe(
      Effect.provide(
        MailerLive.pipe(
          Layer.provide(
            Layer.succeed(EmailSend, {
              from: "noreply@example.com",
              send: () => Effect.fail("unavailable"),
            }),
          ),
        ),
      ),
    ),
  );
  expect(error).toBeInstanceOf(MailerError);
});
test("disabled mail cannot claim delivery; test mail retains templates", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Effect.flip(
        (yield* Mailer).send({ to: "a@example.com", subject: "test", text: "test" }),
      );
    }).pipe(Effect.provide(MailerDisabled)),
  );
  expect(error).toBeInstanceOf(MailerError);
  const messages = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Mailer).send(
        alertMessage("a@example.com", "audit-integrity", "Chain mismatch", "https://cache.test"),
      );
      return yield* (yield* Mailbox).messages;
    }).pipe(Effect.provide(MailerTest)),
  );
  expect(messages[0]?.subject).toBe("Audit integrity failure");
});

test("disabled email still persists alerts and forwards the optional webhook", async () => {
  const persisted: string[] = [];
  const forwarded: string[] = [];
  const { Alerts, AlertsLive, NotificationSink } = await import("./alerts.ts");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Alerts).notify({
        id: "a1",
        userId: "u1",
        kind: "quota",
        detail: "Quota reached",
        to: "a@example.com",
        consoleURL: "https://cache.test",
      });
    }).pipe(
      Effect.provide(
        AlertsLive.pipe(
          Layer.provide(MailerDisabled),
          Layer.provide(
            Layer.succeed(NotificationSink, {
              persist: (alert) =>
                Effect.sync(() => {
                  persisted.push(alert.id);
                }),
              webhook: (alert) =>
                Effect.sync(() => {
                  forwarded.push(alert.id);
                }),
            }),
          ),
        ),
      ),
    ),
  );
  expect(persisted).toEqual(["a1"]);
  expect(forwarded).toEqual(["a1"]);
});

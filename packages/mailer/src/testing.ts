import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Mailer, type MailMessage } from "./mailer.ts";

export class Mailbox extends Context.Service<
  Mailbox,
  { readonly messages: Effect.Effect<readonly MailMessage[]> }
>()("@repo/mailer/Mailbox") {}
export const MailerTest = Layer.effectContext(
  Effect.gen(function* () {
    const messages = yield* Ref.make<readonly MailMessage[]>([]);
    return Context.make(Mailer, {
      send: (message: MailMessage) => Ref.update(messages, (items) => [...items, message]),
    }).pipe(Context.add(Mailbox, { messages: Ref.get(messages) }));
  }),
);

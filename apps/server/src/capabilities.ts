import { CapabilityReport } from "@repo/shared";
import { AnalyticsEmitterDisabled, AnalyticsEmitterLite } from "@repo/analytics";
import { MailerDisabled } from "@repo/mailer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Build-time handoff; never reads local config from a deployed Worker. */
export const DeploymentCapabilities = Context.Reference<CapabilityReport | undefined>(
  "DeploymentCapabilities",
  { defaultValue: () => undefined },
);

export class Capabilities extends Context.Service<Capabilities, CapabilityReport>()(
  "Capabilities",
) {}

/** Selection belongs to composition; consumers only depend on their domain service. */
export const capabilityLayers = Layer.unwrap(
  Effect.gen(function* () {
    const capabilities = yield* Capabilities;

    return Layer.mergeAll(
      MailerDisabled,
      capabilities.analyticsMode === "disabled" ? AnalyticsEmitterDisabled : AnalyticsEmitterLite,
    );
  }),
);

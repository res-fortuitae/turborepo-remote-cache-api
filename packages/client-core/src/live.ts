import { Layer } from "effect";
import { CiProviderLive } from "./ci-provider.ts";
import { ClientConfigLive } from "./config.ts";
import { DpopSignerLive } from "./dpop.ts";
import { ExchangeClientLive } from "./exchange-client.ts";
import { TokenCacheLive } from "./token-cache.ts";

/** Convenience composition; platform, messages, command and developer adapters stay explicit. */
export const ClientCoreLive = TokenCacheLive.pipe(
  Layer.provideMerge(Layer.mergeAll(CiProviderLive, ExchangeClientLive, DpopSignerLive)),
  Layer.provideMerge(ClientConfigLive),
);

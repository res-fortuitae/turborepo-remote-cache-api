import { Context, Effect } from "effect";
export interface ExchangeIdentity {
  readonly provider?: string;
  readonly repositoryId?: string;
  readonly ref?: string;
  readonly jobWorkflowRef?: string;
}
/** OIDC calls this port with verified identity only; the host supplies detection. */
export class ExchangeAnomalies extends Context.Service<
  ExchangeAnomalies,
  {
    readonly checkWrite: (
      orgId: string,
      projectId: string,
      identity: ExchangeIdentity,
    ) => Effect.Effect<boolean, unknown>;
    readonly observe: (
      orgId: string,
      projectId: string,
      allowed: boolean,
      ip: string,
      trustedWrite: boolean,
    ) => Effect.Effect<void, unknown>;
  }
>()("@repo/credentials/ExchangeAnomalies") {}

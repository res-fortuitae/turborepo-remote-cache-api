import { Schema } from "effect";
import type { JWTPayload } from "jose";

const NumericId = Schema.String.check(Schema.isPattern(/^[0-9]+$/));
const Uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
);
const BitbucketUuid = Schema.String.check(
  Schema.isPattern(/^\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}$/i),
);
export const GitLabClaims = Schema.Struct({ project_id: NumericId, namespace_id: NumericId });
export const CircleCiClaims = Schema.Struct({
  "oidc.circleci.com/project-id": Uuid,
  sub: Schema.NonEmptyString,
});
export const BuildkiteClaims = Schema.Struct({ organization_id: Uuid, pipeline_id: Uuid });
export const BitbucketClaims = Schema.Struct({
  workspaceUuid: BitbucketUuid,
  repositoryUuid: BitbucketUuid,
});
export const KubernetesClaims = Schema.Struct({
  sub: Schema.String.check(
    Schema.isPattern(/^system:serviceaccount:[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$/),
  ),
});
export const GoogleClaims = Schema.Struct({ sub: NumericId });
export const AzureClaims = Schema.Struct({
  tid: Uuid,
  oid: Schema.optional(Uuid),
  sub: Schema.NonEmptyString,
});
const gitlab = Schema.is(GitLabClaims);
const circleci = Schema.is(CircleCiClaims);
const buildkite = Schema.is(BuildkiteClaims);
const bitbucket = Schema.is(BitbucketClaims);
const kubernetes = Schema.is(KubernetesClaims);
const google = Schema.is(GoogleClaims);
const azure = Schema.is(AzureClaims);

export interface ProviderProfile {
  readonly provider: string;
  readonly jwksOrigins: readonly string[];
  readonly maxTokenLifetimeSeconds: number;
  readonly optionalTokenId?: boolean;
  readonly optionalNotBefore?: boolean;
  readonly validateClaims: (claims: JWTPayload) => boolean;
  readonly immutableClaims: readonly string[];
}

const uuidPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const circle = new RegExp(`^https://oidc\\.circleci\\.com/org/(${uuidPattern})$`, "i");
const entra = new RegExp(`^https://login\\.microsoftonline\\.com/(${uuidPattern})/v2\\.0$`, "i");
const aks = new RegExp(
  `^https://[a-z0-9-]+\\.oic\\.prod-aks\\.azure\\.com/${uuidPattern}/${uuidPattern}/$`,
  "i",
);

/** Only fixed vendor hosts are discovered. Every exact issuer still needs instance approval. */
export const providerProfile = (issuer: string): ProviderProfile | undefined => {
  if (issuer === "https://gitlab.com")
    return {
      provider: "gitlab",
      jwksOrigins: [issuer],
      maxTokenLifetimeSeconds: 86400,
      validateClaims: gitlab,
      immutableClaims: ["project_id", "namespace_id"],
    };
  const org = circle.exec(issuer)?.[1];

  if (org)
    return {
      provider: "circleci",
      jwksOrigins: ["https://oidc.circleci.com"],
      maxTokenLifetimeSeconds: 3600,
      optionalTokenId: true,
      optionalNotBefore: true,
      validateClaims: (claims) =>
        circleci(claims) &&
        (claims["oidc.circleci.com/org-id"] === undefined ||
          claims["oidc.circleci.com/org-id"] === org) &&
        (claims.sub.startsWith(`org/${org}/project/${claims["oidc.circleci.com/project-id"]}/`) ||
          claims.sub.startsWith(`org:${org}:project:${claims["oidc.circleci.com/project-id"]}:`)),
      immutableClaims: ["oidc.circleci.com/project-id"],
    };

  if (issuer === "https://agent.buildkite.com")
    return {
      provider: "buildkite",
      jwksOrigins: [issuer],
      maxTokenLifetimeSeconds: 7200,
      validateClaims: buildkite,
      immutableClaims: ["organization_id", "pipeline_id"],
    };

  if (
    /^https:\/\/api\.bitbucket\.org\/2\.0\/workspaces\/[a-z0-9_-]+\/pipelines-config\/identity\/oidc$/.test(
      issuer,
    )
  )
    return {
      provider: "bitbucket",
      jwksOrigins: ["https://api.bitbucket.org"],
      maxTokenLifetimeSeconds: 21600,
      optionalTokenId: true,
      optionalNotBefore: true,
      validateClaims: bitbucket,
      immutableClaims: ["workspaceUuid", "repositoryUuid"],
    };

  if (/^https:\/\/oidc\.eks\.[a-z0-9-]+\.amazonaws\.com\/id\/[A-Fa-f0-9]{32}$/.test(issuer))
    return {
      provider: "aws-eks",
      jwksOrigins: [new URL(issuer).origin],
      maxTokenLifetimeSeconds: 86400,
      optionalTokenId: true,
      validateClaims: kubernetes,
      immutableClaims: ["sub"],
    };

  if (issuer === "https://accounts.google.com")
    return {
      provider: "google",
      jwksOrigins: ["https://www.googleapis.com"],
      maxTokenLifetimeSeconds: 3600,
      optionalTokenId: true,
      optionalNotBefore: true,
      validateClaims: google,
      immutableClaims: ["sub"],
    };
  const tenant = entra.exec(issuer)?.[1];

  if (tenant)
    return {
      provider: "azure",
      jwksOrigins: ["https://login.microsoftonline.com"],
      maxTokenLifetimeSeconds: 7200,
      optionalTokenId: true,
      optionalNotBefore: true,
      validateClaims: (claims) => azure(claims) && claims.tid === tenant,
      immutableClaims: ["tid"],
    };

  if (aks.test(issuer))
    return {
      provider: "azure",
      jwksOrigins: [new URL(issuer).origin],
      maxTokenLifetimeSeconds: 86400,
      optionalTokenId: true,
      validateClaims: kubernetes,
      immutableClaims: ["sub"],
    };

  return undefined;
};

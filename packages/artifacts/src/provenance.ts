import type { ResolvedCredential } from "@repo/credentials";

/** Only verified identity enters provenance. Upload headers never override it. */
export const uploadProvenance = (
  credential?: ResolvedCredential,
  uploadedAt = new Date().toISOString(),
): Record<string, string> => ({
  uploadedAt,
  credentialType: credential?.credentialType ?? "legacy",
  credentialId: credential?.credentialId ?? "legacy",
  ...(credential?.subject.startsWith("user:") ? { userId: credential.subject.slice(5) } : {}),
  ...Object.fromEntries(
    Object.entries(credential?.principal.uploadIdentity ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
});

import { SecondaryStorageLive } from "@repo/auth";
import { Layer } from "effect";
import { resolveResidency } from "./residency.ts";

/** Require the deployment-bound setting; a missing or corrupt policy must fail closed. */
export const residencyFromEnvironment = (value: unknown) => {
  if (value === "default") return resolveResidency({});
  if (value === "eu" || value === "fedramp") return resolveResidency({ jurisdiction: value });
  throw new Error("Missing or invalid STORAGE_JURISDICTION deployment setting");
};

/** Absence of this service makes Better Auth use its authoritative D1 storage. */
export const authStorageLayer = (residency: ReturnType<typeof resolveResidency>) =>
  residency.allowKvSessionCache ? SecondaryStorageLive : Layer.empty;

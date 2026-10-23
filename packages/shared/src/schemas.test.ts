import { expect, test } from "bun:test";
import * as ApiSpec from "@repo/api-spec";
import { ArtifactQueryRequest, CacheEvent, CacheEvents } from "./index.ts";

test("legacy cache exports refer to the canonical API schemas", () => {
  expect(ArtifactQueryRequest).toBe(ApiSpec.ArtifactQueryRequest);
  expect(CacheEvent).toBe(ApiSpec.CacheEvent);
  expect(CacheEvents).toBe(ApiSpec.CacheEvents);
});

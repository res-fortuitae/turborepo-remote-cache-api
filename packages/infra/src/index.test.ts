import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AnalyticsBasin, AuditBasin, auditBasinEnabled } from "./index.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "local audit planning never evaluates cloud-only resources or their configuration",
  () =>
    Effect.gen(function* () {
      // No InfraConfig is supplied: dev must exit before resolving catalog props.
      expect(Option.isNone(yield* AuditBasin)).toBe(true);
      expect(Option.isNone(yield* AnalyticsBasin)).toBe(true);
      expect(auditBasinEnabled({ dev: true, jurisdiction: undefined, catalogToken: true })).toBe(
        false,
      );
      expect(auditBasinEnabled({ dev: false, jurisdiction: undefined, catalogToken: true })).toBe(
        true,
      );
      expect(auditBasinEnabled({ dev: false, jurisdiction: "eu", catalogToken: true })).toBe(false);
      expect(auditBasinEnabled({ dev: false, jurisdiction: undefined, catalogToken: false })).toBe(
        false,
      );
    }),
);

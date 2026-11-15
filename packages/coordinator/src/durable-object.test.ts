import { expect, test } from "bun:test";
import { makeCoordinatorNamespace, type Coordinator } from "./durable-object.ts";
import type { Effect } from "effect";

test.each([undefined, "eu", "fedramp"] as const)(
  "Coordinator scopes every lookup to %p",
  (jurisdiction) => {
    const calls: string[] = [];
    const stub = {};
    const scoped = {
      getByName: (name: string) => {
        calls.push(`scoped:${name}`);
        return stub;
      },
    };
    const namespace = {
      jurisdiction: (value: string) => {
        calls.push(`jurisdiction:${value}`);
        return scoped;
      },
      getByName: (name: string) => {
        calls.push(`default:${name}`);
        return stub;
      },
    };
    // SAFETY: only namespace selection and stub capture are exercised; no RPC is invoked.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- minimal platform binding spy.
    const binding = namespace as unknown as Effect.Success<typeof Coordinator>;
    const client = makeCoordinatorNamespace(binding, jurisdiction);
    client.getByName("epoch:org:one");
    client.getByName("chain:org:one");
    expect(calls).toEqual(
      jurisdiction === undefined
        ? ["default:epoch:org:one", "default:chain:org:one"]
        : [`jurisdiction:${jurisdiction}`, "scoped:epoch:org:one", "scoped:chain:org:one"],
    );
  },
);

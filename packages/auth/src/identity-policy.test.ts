import { expect, spyOn, test } from "bun:test";
import { checkGithubPolicy } from "./identity-policy.ts";

test("authenticated membership accepts private active members and rejects pending, missing and unavailable membership", async () => {
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        expect(String(input)).toBe("https://api.github.com/user/memberships/orgs/private-org");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-fixture");
        return Response.json({ state: "active" });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    await checkGithubPolicy(["private-org"], "local-fixture");
    for (const response of [
      Response.json({ state: "pending" }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 500 }),
    ]) {
      transport.mockResolvedValue(response);
      await expect(checkGithubPolicy(["private-org"], "local-fixture")).rejects.toThrow();
    }
    await expect(checkGithubPolicy(["private-org"])).rejects.toThrow();
  } finally {
    transport.mockRestore();
  }
});

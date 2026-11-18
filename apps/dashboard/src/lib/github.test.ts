import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { lookupRepository } from "./github.ts";

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  fetchMock = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchMock.mockRestore();
});

test("public repository lookup returns the immutable IDs without credentials or a referrer", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ full_name: "acme/web", id: 123, owner: { id: 456 }, default_branch: "main" }),
  );

  expect(await lookupRepository("acme/web")).toEqual({
    repository: "acme/web",
    repositoryId: "123",
    repositoryOwnerId: "456",
    defaultBranch: "main",
  });
  expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/acme/web", {
    headers: { accept: "application/vnd.github+json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
});

test("a failed connection offers a retry and manual entry", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  await expect(lookupRepository("acme/web")).rejects.toThrow(
    "Could not reach GitHub. Try again or enter the repository IDs manually.",
  );
});

test.each([
  [404, "Repository not found. Private repositories need their IDs entered manually."],
  [429, "GitHub is unavailable. Enter the repository IDs manually."],
  [503, "GitHub is unavailable. Enter the repository IDs manually."],
])("GitHub HTTP %i has a distinct message from a connection failure", async (status, message) => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status }));

  await expect(lookupRepository("acme/web")).rejects.toThrow(message);
});

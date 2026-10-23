import { expect, test } from "bun:test";
import {
  isReleaseTag,
  migrationNotes,
  releasePullRequestBody,
  type Release,
} from "../scripts/releases.ts";

test("only stable semver tags are selected for automatic upgrades", () => {
  expect(isReleaseTag("v1.2.3")).toBe(true);
  expect(isReleaseTag("v0.0.0")).toBe(true);
  expect(isReleaseTag("v01.2.3")).toBe(false);
  expect(isReleaseTag("v1.2.3-rc.1")).toBe(false);
  expect(isReleaseTag("main")).toBe(false);
  expect(isReleaseTag("v1.2.3;echo bad")).toBe(false);
});

test("extracts the exact version's migrations and fails closed if they are absent", () => {
  const notes =
    "# Upgrading\n\n## Unreleased\nFuture\n\n## v1.2.3\nChange config.\n### Validation\nRun plan.\n\n## v1.2.2\nOld notes.\n";

  expect(migrationNotes(notes, "v1.2.3")).toBe("v1.2.3\nChange config.\n### Validation\nRun plan.");
  expect(() => migrationNotes(notes, "v1.2.4")).toThrow("missing migration notes");
});

test("upgrade PRs contain release notes, migrations, and conflict instructions", () => {
  const release: Release = {
    tag_name: "v1.2.3",
    name: "Release",
    body: "Added configuration.",
    html_url: "https://github.com/example/cache/releases/tag/v1.2.3",
    draft: false,
    prerelease: false,
    published_at: "2026-10-23T00:00:00Z",
  };

  const body = releasePullRequestBody(release, "Update deploy.config.ts.", true);
  expect(body).toContain(release.html_url);
  expect(body).toContain("Added configuration.");
  expect(body).toContain("Update deploy.config.ts.");
  expect(body).toContain("Resolve the conflicts");
  expect(body).toContain("staging Alchemy plan");
});

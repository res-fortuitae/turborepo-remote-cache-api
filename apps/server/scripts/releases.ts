export interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
}

export const isReleaseTag = (tag: string) =>
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag);

export const migrationNotes = (markdown: string, tag: string) => {
  const sections = markdown.split(/^## /m);
  const section = sections.find((text) => text.split("\n", 1)[0]?.trim() === tag);

  if (!section) throw new Error(`UPGRADING.md is missing migration notes for ${tag}`);

  return section.trim();
};

export const releasePullRequestBody = (release: Release, migrations: string, conflicted: boolean) =>
  [
    `Merge upstream release [${release.tag_name}](${release.html_url}).`,
    conflicted
      ? "This release conflicts with local changes. Resolve the conflicts before merging."
      : "The release tag has been merged into the fork's default branch on this PR branch.",
    "## Release notes",
    release.body || "No release notes were supplied.",
    "## Migration notes",
    migrations,
    "Review configuration changes, tests, and the staging Alchemy plan before merging. Deployments remain manual.",
  ].join("\n\n");

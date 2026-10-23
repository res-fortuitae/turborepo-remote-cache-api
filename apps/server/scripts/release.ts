import { isReleaseTag, migrationNotes } from "./releases.ts";

const tag = Bun.env.GITHUB_REF_NAME ?? "";

if (!isReleaseTag(tag)) throw new Error("Release tags must use stable semver: vMAJOR.MINOR.PATCH");

const notes = migrationNotes(await Bun.file("UPGRADING.md").text(), tag);
const notesFile = `${Bun.env.RUNNER_TEMP}/release-notes.md`;

await Bun.write(notesFile, notes);

const child = Bun.spawn(
  ["gh", "release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", notesFile],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await child.exited);

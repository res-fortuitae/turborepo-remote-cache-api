import * as core from "@actions/core";
import { readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { Schema } from "effect";

const State = Schema.Struct({
  TURBO_API: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d+$/)),
  TURBO_TOKEN: Schema.NonEmptyString,
});

const Stats = Schema.Struct({
  hits: Schema.Int,
  misses: Schema.Int,
  uploads: Schema.Int,
  errors: Schema.Int,
  retries: Schema.Int,
});

const main = async () => {
  const directory = core.getState("directory");

  if (!directory || !basename(directory).startsWith("tcache-action-")) return;

  try {
    const state = Schema.decodeUnknownSync(Schema.fromJsonString(State))(
      await readFile(join(directory, "session.json"), "utf8"),
    );

    core.setSecret(state.TURBO_TOKEN);

    const response = await fetch(`${state.TURBO_API}/_tcache/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.TURBO_TOKEN}` },
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });

    if (!response.ok) throw new Error("stop refused");
    const stats = Schema.decodeUnknownSync(Stats)(await response.json());
    await core.summary
      .addHeading("Remote cache")
      .addTable([
        ["Hits", "Misses", "Uploads", "Errors", "Retries"],
        [
          String(stats.hits),
          String(stats.misses),
          String(stats.uploads),
          String(stats.errors),
          String(stats.retries),
        ],
      ])
      .write();
  } catch {
    core.warning(
      "Unable to collect proxy stats or stop it. Runner job cleanup is the fallback; prefer exec on runners without background process support.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

void main().catch(() => core.warning("Remote cache post cleanup failed."));

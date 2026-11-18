import { PurgeFilter, PurgeReport } from "@repo/shared";
import { Schema } from "effect";
import { sessionRequest } from "./account.ts";

const decodeFilter = Schema.decodeUnknownSync(Schema.fromJsonString(PurgeFilter));
const decodeReport = Schema.decodeUnknownSync(PurgeReport);

export async function adminPurge(
  projectId: string,
  { filter, job, confirm }: { filter: string; job: string; confirm: boolean },
) {
  if (!projectId) throw new Error("Pass a project ID.");

  if (confirm && !job) throw new Error("Confirm a completed dry run with --job ID --confirm");

  const body = job ? undefined : decodeFilter(filter || "{}");

  const response = await sessionRequest(
    `/projects/${encodeURIComponent(projectId)}/purges${job ? `/${encodeURIComponent(job)}` : ""}${confirm ? "/confirm" : ""}`,
    !job || confirm ? "POST" : "GET",
    body,
  );

  return decodeReport(await response.json());
}

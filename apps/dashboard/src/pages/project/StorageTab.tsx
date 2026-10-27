import { useEffect, useState } from "react";
import { DatabaseZap, Eraser } from "lucide-react";
import type { ProjectStorage, PurgeReport } from "@repo/shared";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Progress } from "@repo/ui/components/progress";
import { DescriptionList, ErrorState, formatBytes, formatDate } from "../../components/common.tsx";
import { ConfirmDialog, useAction } from "../../components/forms.tsx";
import { EVERYTHING, confirmPurge, getPurge, previewPurge } from "../../lib/projects.ts";

/** Whole-cache purge through the audited incident-purge job: preview, confirm, follow. */
function PurgeCache({
  projectId,
  onDone,
}: {
  readonly projectId: string;
  readonly onDone: () => void;
}) {
  const [job, setJob] = useState<typeof PurgeReport.Type>();
  const [confirming, setConfirming] = useState(false);
  const [pollError, setPollError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const action = useAction();
  const running = job && ["scanning", "queued"].includes(job.state);

  useEffect(() => {
    if (!job || !running) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getPurge(projectId, job.id, controller.signal).then(
        (next) => {
          setPollError(undefined);
          setJob(next);

          if (next.state === "complete") onDone();
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setPollError(error);
        },
      );
    }, 1500);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [job, running, projectId, onDone, retry]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Purge the cache</CardTitle>
        <CardDescription>
          Removes every cached artifact in this project, for example after a poisoned upload. Revoke
          compromised credentials first. Purges are audited.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!job ? null : job.state === "scanning" ? (
          <p className="text-sm text-muted-foreground" role="status">
            Counting artifacts… {job.count} found so far.
          </p>
        ) : job.state === "too_large" ? (
          <ErrorState
            error={
              new Error(
                "Too many artifacts for one purge. Narrow it with filters on the Purge artifacts page.",
              )
            }
          />
        ) : job.state === "ready" ? (
          <p className="text-sm" role="status">
            {job.count} artifact{job.count === 1 ? "" : "s"} ({formatBytes(job.bytes)}) will be
            removed.
          </p>
        ) : (
          <div className="flex flex-col gap-2" role="status">
            <Progress
              value={job.count === 0 ? 100 : (job.removed / job.count) * 100}
              aria-label="Purge progress"
            />
            <p className="text-xs text-muted-foreground">
              {job.state === "complete" ? "Purge complete." : "Removing…"} {job.removed} of{" "}
              {job.count} removed ({formatBytes(job.removedBytes)}).
            </p>
          </div>
        )}
        {action.error === undefined ? null : <ErrorState error={action.error} />}
        {pollError === undefined ? null : (
          <ErrorState
            error={pollError}
            onRetry={() => {
              setPollError(undefined);
              setRetry((value) => value + 1);
            }}
          />
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {job?.state === "ready" ? (
          <>
            <Button
              variant="destructive"
              onClick={() => setConfirming(true)}
              disabled={job.count === 0}
            >
              <Eraser data-icon="inline-start" />
              Remove {job.count} artifact{job.count === 1 ? "" : "s"}
            </Button>
            <Button variant="outline" onClick={() => setJob(undefined)}>
              Cancel
            </Button>
          </>
        ) : running ? null : (
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() =>
              void action
                .run(() => previewPurge(projectId, EVERYTHING))
                .then((report) => report && setJob(report))
            }
          >
            <DatabaseZap data-icon="inline-start" />
            {job?.state === "complete" ? "Start another purge" : "Preview purge"}
          </Button>
        )}
      </CardFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Purge the entire cache?"
        description={`${job?.count ?? 0} artifacts are permanently removed. The next builds run without cache hits and repopulate it.`}
        confirmLabel="Purge cache"
        destructive
        onConfirm={async () => {
          if (job) setJob(await confirmPurge(projectId, job.id));
        }}
      />
    </Card>
  );
}

export function StorageTab({
  projectId,
  storage,
  canPurge,
  onChanged,
}: {
  readonly projectId: string;
  readonly storage: typeof ProjectStorage.Type;
  readonly canPurge: boolean;
  readonly onChanged: () => void;
}) {
  const usage = storage.limits.quotaBytes > 0 ? storage.bytes / storage.limits.quotaBytes : 0;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>
            From the upload ledger; a daily inventory corrects any drift.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                {formatBytes(storage.bytes)}
              </span>
              <span className="text-xs text-muted-foreground">
                of {formatBytes(storage.limits.quotaBytes)} quota
              </span>
            </div>
            <Progress value={Math.min(100, usage * 100)} aria-label="Storage used" />
          </div>
          <DescriptionList
            items={[
              ["Artifacts", <span className="font-mono">{storage.objects}</span>],
              ["Last upload", storage.lastUploadAt ? formatDate(storage.lastUploadAt) : "Never"],
              [
                "Last reconciled",
                storage.reconciledAt ? formatDate(storage.reconciledAt) : "Not yet",
              ],
            ]}
          />
        </CardContent>
      </Card>
      {canPurge ? <PurgeCache projectId={projectId} onDone={onChanged} /> : null}
    </div>
  );
}

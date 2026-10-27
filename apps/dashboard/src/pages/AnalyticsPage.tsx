import { useState } from "react";
import { BarChart3 } from "lucide-react";
import type { AnalyticsResponse } from "@repo/shared";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@repo/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  formatBytes,
  formatDate,
} from "../components/common.tsx";
import { NativeSelect } from "../components/forms.tsx";
import {
  alignedRange,
  drilldown,
  percent,
  readAnalytics,
  type AnalyticsRange,
} from "../lib/analytics.ts";
import { auditExport, readAudit } from "../lib/audit.ts";
import { useOptionalOrg } from "../lib/org.tsx";
import { listProjects } from "../lib/projects.ts";
import { useResource } from "../lib/use-resource.ts";

/** A code-native SVG chart with a full table alternative and per-point values. */
function Trend({
  title,
  series,
  metric,
  format,
}: {
  readonly title: string;
  readonly series: typeof AnalyticsResponse.Type.series;
  readonly metric:
    | "hitRate"
    | "timeSavedMs"
    | "bytesServed"
    | "bytesUploaded"
    | "storageBytes"
    | "edgeCacheHitRate";
  readonly format: (value: number) => string;
}) {
  const max = Math.max(1, ...series.map((point) => point[metric]));
  const points = series
    .map(
      (point, i) =>
        `${40 + (i / Math.max(1, series.length - 1)) * 560},${160 - (point[metric] / max) * 130}`,
    )
    .join(" ");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <svg
          viewBox="0 0 640 200"
          role="img"
          aria-label={`${title}, ${series.length} UTC buckets. Expand data table for exact values.`}
          className="w-full text-primary"
        >
          <line x1="40" x2="600" y1="160" y2="160" stroke="currentColor" opacity="0.2" />
          <text x="5" y="25" fill="currentColor" fontSize="10">
            {format(max)}
          </text>
          <text x="15" y="163" fill="currentColor" fontSize="10">
            0
          </text>
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
          {series.map((point, i) => (
            <circle
              key={point.ts}
              cx={40 + (i / Math.max(1, series.length - 1)) * 560}
              cy={160 - (point[metric] / max) * 130}
              r="3"
              fill="currentColor"
            >
              <title>
                {point.ts}: {format(point[metric])}
              </title>
            </circle>
          ))}
          <text x="40" y="190" fill="currentColor" fontSize="10">
            {series[0]?.ts.slice(0, 16).replace("T", " ")}
          </text>
          <text x="600" y="190" textAnchor="end" fill="currentColor" fontSize="10">
            {series.at(-1)?.ts.slice(0, 16).replace("T", " ")}
          </text>
        </svg>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Data table</summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>UTC bucket</TableHead>
                <TableHead>{title}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.map((point) => (
                <TableRow key={point.ts}>
                  <TableCell>{formatDate(point.ts)}</TableCell>
                  <TableCell>{format(point[metric])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </CardContent>
    </Card>
  );
}

function Drilldowns({
  projectId,
  range,
}: {
  readonly projectId: string;
  readonly range: AnalyticsRange;
}) {
  const [template, setTemplate] = useState<
    "most-missed" | "slowest-tasks" | "edge-cache" | "ref-history"
  >("most-missed");
  const [refInput, setRefInput] = useState("");
  const [ref, setRef] = useState("");
  const resource = useResource(
    template === "ref-history" && !ref
      ? null
      : `drill:${projectId}:${JSON.stringify(range)}:${template}:${ref}`,
    (signal) => drilldown(projectId, range, template, ref, signal),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Project drill-down</CardTitle>
        <CardDescription>
          Basin SQL templates, cached for five minutes. Requires warehouse analytics. Tasks are
          identified by their Turbo artifact hash; task names are not sent in Turbo's cache events.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <NativeSelect
          aria-label="Drill-down"
          value={template}
          onChange={(e) => setTemplate(e.target.value as typeof template)}
        >
          <option value="most-missed">Top missed hashes</option>
          <option value="slowest-tasks">Tasks with most avoided execution time</option>
          <option value="edge-cache">Edge-cache effectiveness by hash</option>
          <option value="ref-history">Branch / ref history</option>
        </NativeSelect>
        {template === "ref-history" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setRef(refInput.trim());
            }}
            className="flex gap-2"
          >
            <Input
              aria-label="Exact git ref"
              placeholder="refs/heads/main"
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
            />
            <Button disabled={!refInput.trim()}>Inspect ref</Button>
          </form>
        ) : null}
        {template === "ref-history" && !ref ? (
          <p className="text-sm text-muted-foreground">Enter an exact ref.</p>
        ) : resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data ? (
          <LoadingRows />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Generated {formatDate(resource.data.generatedAt)}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hash / bucket</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Misses</TableHead>
                  <TableHead>Time saved</TableHead>
                  <TableHead>Bytes</TableHead>
                  <TableHead>Edge hits / misses</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resource.data.rows.map((row, i) => (
                  <TableRow key={`${row.hash}:${row.ts}:${i}`}>
                    <TableCell className="max-w-56 truncate font-mono text-xs" title={row.hash}>
                      {row.hash ?? "—"}
                      {row.ts ? <p>{formatDate(row.ts)}</p> : null}
                    </TableCell>
                    <TableCell>{row.requests}</TableCell>
                    <TableCell>{row.misses}</TableCell>
                    <TableCell>{(row.durationMs / 3600000).toFixed(2)} h</TableCell>
                    <TableCell>{formatBytes(row.bytes)}</TableCell>
                    <TableCell>
                      {row.edgeHits ?? "—"} / {row.edgeMisses ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {resource.data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matching telemetry.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Failures({
  orgId,
  range,
  projectId,
}: {
  readonly orgId?: string;
  readonly projectId?: string;
  readonly range: AnalyticsRange;
}) {
  const filter = { from: range.from, to: range.to };
  const resource = useResource(
    `failures:${orgId}:${projectId}:${JSON.stringify(range)}`,
    async (signal) => {
      const [denials, errors] = await Promise.all([
        readAudit(orgId, { ...filter, outcome: "deny" }, undefined, signal),
        readAudit(orgId, { ...filter, outcome: "error" }, undefined, signal),
      ]);
      return { denials, errors };
    },
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Errors and denials</CardTitle>
        <CardDescription>
          Recent audited failures, up to 100 of each outcome. Audit permission is required. Export
          the complete range from Audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data ? (
          <LoadingRows />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...resource.data.denials.items, ...resource.data.errors.items]
                .filter((event) => !projectId || event.projectId === projectId)
                .sort((a, b) => b.ts.localeCompare(a.ts))
                .map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{formatDate(event.ts)}</TableCell>
                    <TableCell>{event.outcome}</TableCell>
                    <TableCell>{event.action}</TableCell>
                    <TableCell>{event.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
        <a
          href={auditExport(orgId, filter, "jsonl")}
          className="mt-3 inline-block text-sm underline"
          download
        >
          Export full audit range
        </a>
      </CardContent>
    </Card>
  );
}

export function AnalyticsPage({ instance = false }: { readonly instance?: boolean }) {
  const org = useOptionalOrg();
  const projects = useResource(org ? `analytics-projects:${org.id}` : null, (signal) =>
    listProjects(org!.id, signal),
  );
  const [project, setProject] = useState("");
  const [dates, setDates] = useState({
    from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    granularity: "day" as "hour" | "day",
  });
  const [range, setRange] = useState(() => alignedRange(dates.from, dates.to, dates.granularity));
  const [rangeError, setRangeError] = useState<unknown>();
  const orgId = instance ? undefined : org?.id;
  const resource = useResource(`analytics:${orgId}:${project}:${JSON.stringify(range)}`, (signal) =>
    readAnalytics(orgId, project || undefined, range, signal),
  );
  const totals = resource.data?.totals;
  return (
    <>
      <PageHeader
        eyebrow={instance ? "Instance" : "Insights"}
        title="Analytics"
        description="Cache performance and usage from D1 rollups. Published data may lag by an hour; lite mode provides fewer metrics. All dates use UTC."
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            setRange(alignedRange(dates.from, dates.to, dates.granularity));
            setRangeError(undefined);
          } catch (cause) {
            setRangeError(cause);
          }
        }}
      >
        <FieldGroup className="grid gap-3 sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="analytics-from">From (UTC)</FieldLabel>
            <Input
              id="analytics-from"
              required
              type="date"
              value={dates.from}
              onChange={(e) => setDates({ ...dates, from: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="analytics-to">To (UTC, exclusive)</FieldLabel>
            <Input
              id="analytics-to"
              required
              type="date"
              value={dates.to}
              onChange={(e) => setDates({ ...dates, to: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="analytics-bucket">Bucket</FieldLabel>
            <NativeSelect
              id="analytics-bucket"
              value={dates.granularity}
              onChange={(e) =>
                setDates({ ...dates, granularity: e.target.value as "hour" | "day" })
              }
            >
              <option value="day">Day</option>
              <option value="hour">Hour</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="analytics-project">Scope</FieldLabel>
            <NativeSelect
              id="analytics-project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">{instance ? "Entire instance" : "Entire organization"}</option>
              {projects.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </FieldGroup>
        <Button className="self-start">Apply range</Button>
      </form>
      {rangeError === undefined ? null : <ErrorState error={rangeError} />}
      {resource.status === "error" ? (
        <ErrorState error={resource.error} onRetry={resource.reload} />
      ) : !resource.data || !totals ? (
        <LoadingRows rows={5} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Remote hit rate", percent(totals.hitRate)],
              ["Time saved", `${(totals.timeSavedMs / 3600000).toFixed(2)} h`],
              ["Bandwidth served", formatBytes(totals.bytesServed)],
              ["Current storage", formatBytes(totals.storageBytes)],
              ["Requests", totals.requests.toLocaleString()],
              ["CI / local", `${totals.ciRequests} / ${totals.localRequests}`],
              ["Edge hit rate", percent(totals.edgeCacheHitRate)],
              ["Uploaded", formatBytes(totals.bytesUploaded)],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardHeader>
                  <CardDescription>{label}</CardDescription>
                  <CardTitle className="font-mono text-xl">{value}</CardTitle>
                </CardHeader>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Trend
              title="Remote hit rate"
              series={resource.data.series}
              metric="hitRate"
              format={percent}
            />
            <Trend
              title="Time saved"
              series={resource.data.series}
              metric="timeSavedMs"
              format={(value) => `${(value / 3600000).toFixed(2)} h`}
            />
            <Trend
              title="Bandwidth served"
              series={resource.data.series}
              metric="bytesServed"
              format={formatBytes}
            />
            <Trend
              title="Edge-cache hit rate"
              series={resource.data.series}
              metric="edgeCacheHitRate"
              format={percent}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Storage growth</CardTitle>
              <CardDescription>
                Hourly observations from the accounting ledger, carried forward within this range.
                Gaps remain unknown until every project in scope has an observation. Current
                reconciled storage: {formatBytes(totals.storageBytes)}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {resource.data.series.some((point) => point.storageObserved) ? (
                <Trend
                  title="Observed storage"
                  series={resource.data.series.filter((point) => point.storageObserved)}
                  metric="storageBytes"
                  format={formatBytes}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No complete storage history in this range yet. Observations begin with uploads,
                  removals or inventory reconciliation after this version is installed.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                {project
                  ? "Provider / repository / branch breakdown"
                  : "Usage by project or organization"}
              </CardTitle>
              <CardDescription>
                Top 100 dimensions. Counts may be sampled estimates. Session counts are summed
                across buckets.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {resource.data.breakdowns.length === 0 ? (
                <EmptyState
                  icon={<BarChart3 />}
                  title="No breakdowns yet"
                  description="Basin rollups publish provider/repository/ref dimensions. Lite mode reports project counters."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dimension</TableHead>
                      <TableHead>Requests</TableHead>
                      <TableHead>Hit rate</TableHead>
                      <TableHead>Time saved</TableHead>
                      <TableHead>CI / local</TableHead>
                      <TableHead>Bytes served</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {resource.data.breakdowns.map((row) => (
                      <TableRow key={`${row.kind}:${row.id}`}>
                        <TableCell className="max-w-80 truncate font-mono text-xs" title={row.id}>
                          {row.kind}: {row.id}
                        </TableCell>
                        <TableCell>{row.requests}</TableCell>
                        <TableCell>{percent(row.hitRate)}</TableCell>
                        <TableCell>{(row.timeSavedMs / 3600000).toFixed(2)} h</TableCell>
                        <TableCell>
                          {row.ciRequests} / {row.localRequests}
                        </TableCell>
                        <TableCell>{formatBytes(row.bytesServed)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {project ? (
        <Drilldowns key={`${project}:${JSON.stringify(range)}`} projectId={project} range={range} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a project for hash, task and ref drill-downs.
        </p>
      )}
      <Failures
        key={`${orgId}:${project}:${JSON.stringify(range)}`}
        orgId={orgId}
        projectId={project || undefined}
        range={range}
      />
    </>
  );
}

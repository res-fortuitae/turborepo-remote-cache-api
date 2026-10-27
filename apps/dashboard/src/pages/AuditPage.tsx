import { useEffect, useState } from "react";
import { Download, ScrollText } from "lucide-react";
import type { AuditEvent } from "@repo/shared";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Switch } from "@repo/ui/components/switch";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@repo/ui/components/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import {
  DescriptionList,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  formatDate,
} from "../components/common.tsx";
import { NativeSelect } from "../components/forms.tsx";
import {
  auditExport,
  mergeAudit,
  readAudit,
  searchAudit,
  tailAudit,
  type AuditFilter,
} from "../lib/audit.ts";
import { useOptionalOrg } from "../lib/org.tsx";

const dateInput = (date: number) => new Date(date).toISOString().slice(0, 16);

function AuditTimeline({
  orgId,
  filter,
}: {
  readonly orgId?: string;
  readonly filter: AuditFilter;
}) {
  const [items, setItems] = useState<ReadonlyArray<AuditEvent>>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AuditEvent>();
  const [updated, setUpdated] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(undefined);
    readAudit(orgId, filter, undefined, controller.signal)
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setItems(page.items);
          setCursor(page.nextCursor);
          setUpdated(new Date().toISOString());
        },
        (cause: unknown) => {
          if (!controller.signal.aborted) setError(cause);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [orgId, filter, attempt]);

  // Sequential tail reads avoid overlap on a slow history backend. A remount on
  // filter changes cancels outstanding requests and clears the old cursor.
  useEffect(() => {
    if (!live || busy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      tailAudit(
        orgId,
        { ...filter, to: new Date().toISOString() },
        new Set(items.map((event) => event.id)),
        controller.signal,
      )
        .then(
          (page) => {
            if (controller.signal.aborted) return;
            setItems((previous) => mergeAudit(previous, page));
            setError(undefined);
            setUpdated(new Date().toISOString());
          },
          (cause: unknown) => {
            if (!controller.signal.aborted) setError(cause);
          },
        )
        .finally(() => {
          if (!controller.signal.aborted) setTick((value) => value + 1);
        });
    }, 5000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [live, busy, orgId, filter, tick, items]);

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await readAudit(orgId, filter, cursor);
      setItems((previous) => mergeAudit(previous, page.items));
      setCursor(page.nextCursor);
      setError(undefined);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  const visible = searchAudit(items, query);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Input
          className="max-w-sm"
          aria-label="Search loaded events"
          placeholder="Search loaded events, metadata or claims…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <Switch id="audit-tail" checked={live} onCheckedChange={setLive} />
          <label htmlFor="audit-tail" className="text-sm">
            Live tail (5s)
          </label>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          render={<a href={auditExport(orgId, filter, "csv")} download />}
          nativeButton={false}
        >
          <Download data-icon="inline-start" />
          Export CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          render={<a href={auditExport(orgId, filter, "jsonl")} download />}
          nativeButton={false}
        >
          Export JSONL
        </Button>
        <p className="self-center text-xs text-muted-foreground">
          Exports include the full applied date range and filters. Text search applies to loaded
          events.
        </p>
      </div>
      {error === undefined ? null : (
        <ErrorState error={error} onRetry={() => setAttempt((value) => value + 1)} />
      )}
      {busy && cursor === undefined ? (
        <LoadingRows rows={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title="No audit events"
          description="Try a wider date range or fewer filters."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="whitespace-nowrap text-xs">{formatDate(event.ts)}</TableCell>
                <TableCell>
                  <span>{event.actor.display}</span>
                  <p className="font-mono text-xs text-muted-foreground">{event.actor.type}</p>
                </TableCell>
                <TableCell className="font-mono text-xs">{event.action}</TableCell>
                <TableCell className="max-w-56 truncate font-mono text-xs" title={event.target.id}>
                  {event.target.type}: {event.target.id}
                </TableCell>
                <TableCell>
                  <Badge variant={event.outcome === "deny" ? "destructive" : "outline"}>
                    {event.outcome}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelected(event)}
                    aria-label={`Details for ${event.action} at ${event.ts}`}
                  >
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {items.length > 0 && visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No loaded events match your search.</p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {items.length} loaded{updated ? ` · Updated ${formatDate(updated)}` : ""}
          {live ? " · Live" : ""}
        </p>
        {cursor ? (
          <Button disabled={busy} variant="outline" onClick={() => void more()}>
            {busy ? "Loading…" : "Load older events"}
          </Button>
        ) : null}
      </div>
      <Sheet
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selected?.action ?? "Audit event"}</SheetTitle>
            <SheetDescription>
              {selected ? formatDate(selected.ts) : "Event details"}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <div className="flex flex-col gap-5 p-4">
              <DescriptionList
                items={[
                  ["Event ID", selected.id],
                  ["Actor", `${selected.actor.display} (${selected.actor.id})`],
                  ["Target", `${selected.target.type}: ${selected.target.id}`],
                  ["Outcome", selected.outcome],
                  ["Reason", selected.reason ?? "—"],
                  ["Organization", selected.orgId ?? "Instance"],
                  ["Project", selected.projectId ?? "—"],
                  ["IP", selected.ip],
                  ["Request ID", selected.requestId],
                  ["User agent", selected.userAgent],
                ]}
              />
              <div>
                <h3 className="mb-2 text-sm font-medium">Metadata and OIDC claims snapshot</h3>
                <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(selected.metadata, null, 2)}
                </pre>
              </div>
              <details className="text-xs">
                <summary>Hash chain</summary>
                <p className="break-all font-mono">
                  Previous: {selected.prevHash ?? "genesis"}
                  <br />
                  Hash: {selected.hash}
                </p>
              </details>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function AuditPage({ instance = false }: { readonly instance?: boolean }) {
  const org = useOptionalOrg();
  const [fields, setFields] = useState({
    from: dateInput(Date.now() - 7 * 86400000),
    to: dateInput(Date.now() + 60000),
    actor: "",
    action: "",
    target: "",
    outcome: "",
  });
  const [filter, setFilter] = useState<AuditFilter>(() => ({
    from: new Date(fields.from + "Z").toISOString(),
    to: new Date(fields.to + "Z").toISOString(),
  }));
  const valid =
    Number.isFinite(Date.parse(fields.from)) &&
    Number.isFinite(Date.parse(fields.to)) &&
    fields.from < fields.to;
  return (
    <>
      <PageHeader
        eyebrow={instance ? "Instance" : "Insights"}
        title="Audit log"
        description="Search changes, access decisions and CI exchanges. All times are UTC. Export requires audit export permission."
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            setFilter({
              ...fields,
              from: new Date(fields.from + "Z").toISOString(),
              to: new Date(fields.to + "Z").toISOString(),
              outcome: fields.outcome as AuditFilter["outcome"],
            });
        }}
        className="flex flex-col gap-4"
      >
        <FieldGroup className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(["from", "to", "actor", "action", "target"] as const).map((name) => (
            <Field key={name}>
              <FieldLabel htmlFor={`audit-${name}`}>
                {name === "from"
                  ? "From (UTC)"
                  : name === "to"
                    ? "To (UTC, exclusive)"
                    : `${name[0]!.toUpperCase()}${name.slice(1)} (exact ID/name)`}
              </FieldLabel>
              <Input
                id={`audit-${name}`}
                type={name === "from" || name === "to" ? "datetime-local" : "text"}
                required={name === "from" || name === "to"}
                value={fields[name]}
                onChange={(e) => setFields({ ...fields, [name]: e.target.value })}
              />
            </Field>
          ))}
          <Field>
            <FieldLabel htmlFor="audit-outcome">Outcome</FieldLabel>
            <NativeSelect
              id="audit-outcome"
              value={fields.outcome}
              onChange={(e) => setFields({ ...fields, outcome: e.target.value })}
            >
              <option value="">All outcomes</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
              <option value="error">Error</option>
            </NativeSelect>
          </Field>
        </FieldGroup>
        <Button className="self-start" disabled={!valid} type="submit">
          Apply filters
        </Button>
      </form>
      <AuditTimeline
        key={`${instance ? "instance" : org?.id}:${JSON.stringify(filter)}`}
        orgId={instance ? undefined : org?.id}
        filter={filter}
      />
    </>
  );
}

import { ArtifactSigningStatus } from "@repo/shared";
import { useState } from "react";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Field, FieldLabel } from "@repo/ui/components/field";
import { ErrorState, LoadingRows, formatDate } from "../../components/common.tsx";
import { ConfirmDialog, useAction } from "../../components/forms.tsx";
import { api } from "../../lib/api.ts";
import { useResource } from "../../lib/use-resource.ts";
export function SigningCard({ projectId }: { readonly projectId: string }) {
  const path = `/projects/${encodeURIComponent(projectId)}/signing`;
  const resource = useResource(`signing:${projectId}`, (signal) =>
    api(path, { schema: ArtifactSigningStatus, signal }),
  );
  const [rotating, setRotating] = useState(false);
  const action = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Artifact signatures <Badge variant="outline">HMAC-SHA256</Badge>
        </CardTitle>
        <CardDescription>
          Signing keys are encrypted in the database. Authorized OIDC jobs and developer-token
          clients receive keys automatically. Enable{" "}
          <code className="font-mono">remoteCache.signature</code> in turbo.json to verify
          downloads. Signing does not prevent a compromised trusted job from poisoning the cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data ? (
          <LoadingRows />
        ) : (
          <>
            <Field orientation="horizontal">
              <Checkbox
                id="project-signing-required"
                checked={resource.data.required || resource.data.instanceRequired}
                disabled={
                  resource.data.instanceRequired || resource.data.keys.length === 0 || action.busy
                }
                onCheckedChange={(required) =>
                  void action
                    .run(() => api(path, { method: "POST", body: { required: required === true } }))
                    .then(resource.reload)
                }
              />
              <FieldLabel htmlFor="project-signing-required">
                Require a signature tag on uploads
                {resource.data.instanceRequired ? " (instance enforced)" : ""}
              </FieldLabel>
            </Field>
            <ul className="flex flex-col gap-2 text-xs">
              {resource.data.keys.map((key) => (
                <li key={key.id}>
                  <code>{key.id}</code> · created{" "}
                  {formatDate(new Date(key.createdAt).toISOString())}
                  {key.retiredAt
                    ? ` · overlap ends ${formatDate(new Date(key.retiredAt).toISOString())}`
                    : " · current"}
                </li>
              ))}
            </ul>
            <Button variant="outline" className="self-start" onClick={() => setRotating(true)}>
              {resource.data.keys.length ? "Rotate signing key" : "Generate signing key"}
            </Button>
          </>
        )}
        {action.error === undefined ? null : <ErrorState error={action.error} />}
      </CardContent>
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title="Rotate artifact signing key?"
        description="The previous key remains available for 24 hours. Running jobs keep their key during that overlap. Proxy mode verifies and translates old tags; env mode treats different-key artifacts as misses. Repeated rotation is blocked until the previous overlap expires."
        confirmLabel="Rotate key"
        onConfirm={async () => {
          await api(`${path}/rotate`, { method: "POST" });
          resource.reload();
        }}
      />
    </Card>
  );
}

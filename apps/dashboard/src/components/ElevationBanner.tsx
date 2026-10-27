import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { elevations, leaveElevation } from "../lib/instance.ts";
import { useOptionalOrg } from "../lib/org.tsx";
import { navigate, useLocation } from "../lib/router.tsx";
import { useResource } from "../lib/use-resource.ts";
import { useAction } from "./forms.tsx";
import { ErrorState } from "./common.tsx";

export function ElevationBanner({ role }: { readonly role?: string | null }) {
  const org = useOptionalOrg();
  const location = useLocation();
  const [now, setNow] = useState(Date.now());
  const active = useResource(
    role === "owner" || role === "admin" ? `elevations:${location}` : null,
    elevations,
  );
  const action = useAction();
  const elevation = active.data?.elevations.find((entry) => entry.orgId === org?.id);
  useEffect(() => {
    if (!elevation) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [elevation]);
  if (!elevation) return null;
  const remaining = Math.max(0, Math.ceil((elevation.expiresAt - now) / 1000));
  return (
    <Alert>
      <ShieldAlert />
      <AlertTitle>
        {remaining > 0 ? `Elevated access · ${remaining}s remaining` : "Elevated access expired"}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>
          {elevation.reason}.{" "}
          {remaining > 0
            ? "Administrative access is temporary and audited."
            : "Refresh or return to the instance console; privileged requests are now denied by the server."}
        </p>
        <Button
          className="self-start"
          variant="outline"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await leaveElevation(elevation.orgId);
              navigate("/instance");
            })
          }
        >
          Leave organization
        </Button>
        {action.error === undefined ? null : <ErrorState error={action.error} />}
      </AlertDescription>
    </Alert>
  );
}

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { ErrorState } from "../components/common.tsx";
import { useAction } from "../components/forms.tsx";
import { ApiError } from "../lib/api.ts";
import { authClient } from "../lib/auth-client.ts";
import { acceptSignedInvitation } from "../lib/org-admin.ts";
import { navigate } from "../lib/router.tsx";

/** Opens from a signed link: `/#invitation?id=…&expires=…&signature=…`. */
export function AcceptInvitationPage({ params }: { readonly params: URLSearchParams }) {
  const id = params.get("id") ?? "";
  const signature = params.get("signature") ?? "";
  const expires = Number(params.get("expires"));
  const expired = Number.isFinite(expires) && expires <= Date.now();
  const action = useAction();
  const [done, setDone] = useState(false);

  async function accept() {
    const result = await action.run(() => acceptSignedInvitation(id, signature));

    if (result !== undefined) {
      setDone(true);
      // The new org appears in the switcher; Home picks it as the active org.
      await authClient.organization.setActive({
        organizationId: result.organizationId ?? null,
      });
      navigate("/", { replace: true });
      window.location.reload();
    }
  }

  return (
    <div className="mx-auto w-full max-w-md py-10">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MailCheck className="size-5" aria-hidden="true" />
            Join an organization
          </CardTitle>
          <CardDescription>
            Accept to join with the role chosen by the person who invited you. The invitation must
            be for the email address on your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!id || !signature ? (
            <ErrorState
              error={new Error("This invitation link is incomplete. Ask for a new link.")}
            />
          ) : expired ? (
            <ErrorState
              error={new Error("This invitation has expired. Ask for a new invitation.")}
            />
          ) : null}
          {action.error === undefined ? null : (
            <ErrorState
              error={
                action.error instanceof ApiError && action.error.status === 403
                  ? new Error(
                      "This invitation is for a different email address, was already used, or your instance's sign-up rules don't allow it. Sign in with the invited account or ask for a new invitation.",
                    )
                  : action.error
              }
            />
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={() => navigate("/")}>
            Not now
          </Button>
          <Button
            disabled={!id || !signature || expired || action.busy || done}
            onClick={() => void accept()}
          >
            {action.busy ? "Joining…" : "Accept invitation"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

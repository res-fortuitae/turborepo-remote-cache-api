import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@repo/ui/components/card";

export function DevicePage() {
  const [code, setCode] = useState(
    () => new URLSearchParams(location.search).get("user_code") ?? "",
  );
  const [review, setReview] = useState<{
    client_name: string;
    request_ip: string;
    scope?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function verify() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/auth/device?user_code=${encodeURIComponent(code)}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        setMessage("Sign in with GitHub, then check your code.");
        return;
      }
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (value.status !== "pending" || value.client_id !== "tcache") throw new Error();
      setReview(value);
    } catch {
      setMessage("This code is invalid, expired, or already processed.");
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/device/${decision}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });
      if (!response.ok) throw new Error();
      setReview(undefined);
      setCode("");
      setMessage(
        decision === "approve" ? "Device approved. Return to your terminal." : "Device denied.",
      );
    } catch {
      setMessage("Unable to process this request. Check the code again.");
      setReview(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function signIn() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: location.href }),
      });
      const value = await response.json();
      if (!response.ok || typeof value.url !== "string") throw new Error();
      location.assign(value.url);
    } catch {
      setMessage("GitHub sign-in is unavailable. Contact your instance administrator.");
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authorize your CLI</CardTitle>
        <CardDescription>
          Only approve a device in your possession. Never approve an unexpected request or a code
          sent by someone else.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="device-code">Code shown in your terminal</FieldLabel>
            <Input
              id="device-code"
              value={code}
              maxLength={12}
              autoComplete="off"
              disabled={busy || !!review}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
        </FieldGroup>
        {review ? (
          <>
            <dl>
              <dt>Client</dt>
              <dd>{review.client_name}</dd>
              <dt>Requesting IP</dt>
              <dd>{review.request_ip}</dd>
              <dt>Access</dt>
              <dd>Sign in as you; project cache access is issued separately.</dd>
            </dl>
            <p>Confirm that the code above matches your terminal before approving.</p>
            <div className="flex gap-3">
              <Button disabled={busy} onClick={() => void decide("approve")}>
                Approve this device
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void decide("deny")}>
                Deny
              </Button>
            </div>
          </>
        ) : (
          <div className="flex gap-3">
            <Button disabled={busy || !code} onClick={() => void verify()}>
              Check code
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void signIn()}>
              Sign in with GitHub
            </Button>
          </div>
        )}
        <p role="status">{message}</p>
      </CardContent>
      <CardFooter>Device requests expire after five minutes.</CardFooter>
    </Card>
  );
}

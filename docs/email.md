# Transactional email

Email uses Cloudflare Email Service through Alchemy's `Email.Send` binding.
Configure a sender in `deploy.config.ts`:

```ts
email: { from: "cache@example.com" },
features: { edgeCache: true, emailSending: true },
```

The sender domain must be the configured custom domain's zone (for example,
`cache.example.com` can send as `cache@example.com`). Before deployment, onboard
that domain in Cloudflare Email Service and publish its generated SPF and DKIM
DNS records; add a DMARC record according to your organization's policy. Verify
that Cloudflare reports the domain ready. Config is an operator assertion that
onboarding is complete, not a DNS verification probe. Workers Paid is required
for arbitrary recipients in this integration. Do not deploy just to test email.

The Worker binds `TransactionalEmail`. `MailerLive` wraps the binding with a
typed failure, logging acceptance/failure without message bodies. Acceptance
is not proof of delivery. `MailerConsole` is available for local development;
Alchemy also supports its local `.eml` simulator. `MailerTest` exposes a Mailbox
for assertions. `MailerDisabled` fails explicitly. Magic-link login must never
use a disabled sender.

Invitation links contain an HMAC over the invitation ID and expiry, use the
canonical origin, and stay in the URL fragment. Acceptance additionally checks
the authenticated recipient and atomically consumes the pending D1 invitation.
Email is optional: org administrators can retrieve the same signed link and
share it themselves. The organization API integrates this flow in STV-434;
the dashboard invitation screen belongs to STV-468.

Templates include org invitations, device approvals, API-key expiry and unused
key digests, anomaly and quota warnings, and audit-integrity failures. Alert
producers and their dashboard views belong to their respective later milestones.

References: [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
and [send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

# OIDC UI forms

Provider forms, claim editor, picker and `src/lib/oidc/policy.ts` originate from
[Vercel/shadcn OIDC UI](https://ui.shadcn.com/oidc), installed with the shadcn CLI
on 2026-10-27. Provider variants use TanStack Form and Zod. Source is maintained
here after installation; local adaptations preserve strict TypeScript indexing
and use the shared Mira components.

`PolicyEditor` adds API audience, immutable IDs, scope, TTL, DPoP binding, workflow
and environment restrictions. The backend's Effect schemas and guardrails are
the authority. Provider defaults are suggestions; they do not bypass guardrails.
Existing policies use an exact-rule editor so unsupported shapes retain claims.
The UI never imports the registry's verifier. Policy testing calls the server's
simulation endpoint and does not verify tokens or issue credentials.

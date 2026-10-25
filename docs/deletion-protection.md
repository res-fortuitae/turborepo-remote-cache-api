# Deletion protection

The root composition applies Alchemy's `RemovalPolicy.retain()` to persistent
infrastructure. Alchemy skips the provider's delete operation on destroy,
orphaning (including removing or renaming a declaration), and replacement of an
old generation. It drops the state row; the cloud object survives. This is an
Alchemy lifecycle policy, not protection against manual Cloudflare deletion or
application writes.

The scope retains D1 (`Database`), audit storage (`AuditCatalog`,
`AuditDataCatalog`, `AuditCheckpoints`), the audit stream/sink/pipeline, backup
storage (`Backups`), Secrets Store secrets, and the API Worker (`Api`). Alchemy
hosts the `Coordinator` Durable Object namespace inside that Worker, rather than
as a separately deletable resource. Retaining the Worker preserves that namespace.
The retained Worker, routes and cron triggers remain active after stack destroy;
its artifact bucket and KV will have been removed. Destroy is not a shutdown
procedure. Coordinate a deliberate shutdown separately.

`Artifacts` and `Cache` explicitly use `destroy`: artifacts may expire or be
rebuilt, and KV holds rebuildable caches. No analytics catalog is declared yet;
future analytics storage must explicitly use `destroy` outside the audit scope.
The account-wide Secrets Store itself is never deleted by its Alchemy provider,
including in previews; preview secrets inside it can be deleted.

`Backups` reserves a bucket with the configured jurisdiction. It does not install
a backup job or populate any backups.

## Stage selection

Configured `stages.production` and `stages.staging` always retain persistent
resources. Every other stage also retains them unless its name matches one of:

- `preview-<nonempty suffix>` (for example `preview-login`)
- `pr-<number>` or `pr-<number>-<nonempty suffix>` (for example `pr-42`)

These preview stages use `destroy` for cleanup. Unknown/custom/development stages
fail closed and retain data. In particular, the deployed test harness's default
`test_$USER` is retained; explicitly choose `ALCHEMY_TEST_STAGE=preview-test_$USER`
when authorizing a disposable deployed test. Bucket object locks still apply in
preview stages: a checkpoint bucket with locked objects cannot be deleted until
the locks expire.

## Existing installations and recovery

1. Preserve the current stack name, stage, resource IDs, configuration and Alchemy
   state. Review a plan for that exact stage with `bun run plan --stage <stage>`.
2. On the next authorized deployment, run `bun run deploy --stage <stage>`.
   Alchemy persists the policy even if the plan reports no resource diff. Merely
   checking out this release does not protect rows from an earlier deployment.
3. After a destroy or state loss, inventory retained resource names and IDs in
   Cloudflare and recover the original config and secret values. Keep the same
   stage and logical IDs. Run `bun run plan --stage <stage> --adopt`, review the
   proposed adoption, and then, when authorized, run
   `bun run deploy --stage <stage> --adopt`. Adoption enables providers to read
   existing objects instead of duplicating them. Check the adopted D1/bucket IDs
   and Coordinator namespace before returning the instance to service.

Do not change jurisdiction, stage, or logical IDs as a recovery shortcut. The
tests freeze current resource IDs/types and the Coordinator/Worker names; a
future rename needs an explicit migration. The new `AuditDataCatalog` declaration
fixes a prior collision with the `AuditCatalog` bucket's logical ID; the existing
bucket keeps its name and data.

## Intentional permanent deletion

Permanent removal is an operator action outside normal `destroy`:

1. Identify the exact Cloudflare account, stack/stage, physical names and IDs
   from Alchemy state and Cloudflare. Export needed D1, audit and backup data;
   record namespace IDs and arrange credential rotation for any surviving clients.
2. Stop traffic and disable the retained Worker's routes and cron triggers in
   Cloudflare. Remove the stage from automation so it cannot be redeployed.
3. If still tracked, run an explicitly authorized root
   `bun run destroy --stage <stage>` to forget retained resources and remove
   disposable resources. This does not delete the retained data.
4. In Cloudflare, explicitly delete the stage's Worker and its Coordinator
   namespace, D1 database, audit pipeline/sink/stream and catalog, audit and backup
   buckets, and stage-prefixed secrets, checking each physical ID. Inspect the
   Durable Object namespace list to verify namespace removal. Empty buckets only
   after object locks permit removal; checkpoint locks must be allowed to expire.
5. Do not delete the account-wide Secrets Store or another stage's secrets.
   Verify the inventory after deletion and retain the approved deletion record.

Removing declarations or temporarily renaming a stage is not a permanent deletion
procedure. Never use account-wide resource deletion to clean up one stage.

Alchemy references: [resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle),
[adopting resources](https://alchemy.run/cli/adopting-resources).

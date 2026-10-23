CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY,
	`ts` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`org_id` text,
	`project_id` text,
	`payload` text NOT NULL,
	`prev_hash` text,
	`hash` text,
	`exported_at` integer
);
--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`id` integer PRIMARY KEY DEFAULT 1,
	`schema_version` integer NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`retention_days` integer,
	`max_artifact_bytes` integer,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `project_grant` (
	`project_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `project_grant_pk` PRIMARY KEY(`project_id`, `principal_type`, `principal_id`),
	CONSTRAINT `fk_project_grant_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`),
	CONSTRAINT "grant_principal_type" CHECK("principal_type" in ('user', 'team')),
	CONSTRAINT "grant_role" CHECK("role" in ('project:admin', 'cache:write', 'cache:read'))
);
--> statement-breakpoint
CREATE TABLE `rollup` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`metric` text NOT NULL,
	`value` integer NOT NULL,
	CONSTRAINT `rollup_pk` PRIMARY KEY(`org_id`, `project_id`, `bucket_start`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `trust_policy` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT `fk_trust_policy_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`)
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL UNIQUE,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event_outbox` ON `audit_event` (`exported_at`,`ts`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_org_slug` ON `project` (`org_id`,`slug`);--> statement-breakpoint
CREATE INDEX `trust_policy_project` ON `trust_policy` (`project_id`);--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
CREATE TABLE `quota_config` (
	`org_id` text NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`storage_bytes` integer,
	`bandwidth_bytes` integer,
	`requests` integer,
	`on_quota_exceeded` text DEFAULT 'reject' NOT NULL,
	CONSTRAINT `quota_config_pk` PRIMARY KEY(`org_id`, `project_id`)
);
--> statement-breakpoint
CREATE TABLE `quota_eviction` (
	`project_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`id` text NOT NULL,
	`state` text NOT NULL,
	`cursor` text,
	`candidates` text DEFAULT '[]' NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`removed_bytes` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quota_reservation` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`transfer_bytes` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quota_usage` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`day` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`bandwidth_bytes` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `quota_usage_pk` PRIMARY KEY(`org_id`, `project_id`, `day`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quota_active_hash` ON `quota_reservation` (`project_id`,`hash`);
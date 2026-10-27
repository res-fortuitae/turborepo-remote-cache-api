CREATE TABLE `anomaly_config` (
	`project_id` text PRIMARY KEY,
	`enabled` integer DEFAULT true NOT NULL,
	`read_only_on_alert` integer DEFAULT false NOT NULL,
	`revoke_on_alert` integer DEFAULT false NOT NULL,
	`min_hourly_writes` integer DEFAULT 100 NOT NULL,
	`volume_multiplier` integer DEFAULT 5 NOT NULL,
	`max_exchange_ips` integer DEFAULT 20 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `anomaly_hour` (
	`project_id` text NOT NULL,
	`org_id` text NOT NULL,
	`hour` integer NOT NULL,
	`writes` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`signed` integer DEFAULT 0 NOT NULL,
	`unsigned` integer DEFAULT 0 NOT NULL,
	`exchanges` integer DEFAULT 0 NOT NULL,
	`denied` integer DEFAULT 0 NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	CONSTRAINT `anomaly_hour_pk` PRIMARY KEY(`project_id`, `hour`)
);
--> statement-breakpoint
CREATE TABLE `anomaly_identity` (
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`samples` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `anomaly_identity_pk` PRIMARY KEY(`project_id`, `kind`, `value`)
);
--> statement-breakpoint
CREATE TABLE `anomaly_incident` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`code` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `anomaly_state` (
	`project_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`revocation_pending` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);

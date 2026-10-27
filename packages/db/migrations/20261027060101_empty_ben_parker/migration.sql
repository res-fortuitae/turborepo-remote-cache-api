CREATE TABLE `usage_daily` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`day` integer NOT NULL,
	`dimension` text NOT NULL,
	`metrics` text NOT NULL,
	CONSTRAINT `usage_daily_pk` PRIMARY KEY(`org_id`, `project_id`, `day`, `dimension`)
);
--> statement-breakpoint
CREATE TABLE `usage_hourly` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`hour` integer NOT NULL,
	`source` text NOT NULL,
	`dimension` text NOT NULL,
	`metrics` text NOT NULL,
	CONSTRAINT `usage_hourly_pk` PRIMARY KEY(`org_id`, `project_id`, `hour`, `source`, `dimension`)
);
--> statement-breakpoint
CREATE TABLE `usage_inventory` (
	`project_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`cursor` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer
);

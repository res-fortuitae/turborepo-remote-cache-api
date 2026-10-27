CREATE TABLE `artifact_usage` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`hash` text NOT NULL,
	`bytes` integer NOT NULL,
	CONSTRAINT `artifact_usage_pk` PRIMARY KEY(`org_id`, `project_id`, `hash`)
);
--> statement-breakpoint
CREATE TABLE `project_usage` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`reconciled_at` integer,
	CONSTRAINT `project_usage_pk` PRIMARY KEY(`org_id`, `project_id`)
);
--> statement-breakpoint
ALTER TABLE `project` ADD `first_hit_at` integer;--> statement-breakpoint
ALTER TABLE `project` ADD `last_seen_at` integer;
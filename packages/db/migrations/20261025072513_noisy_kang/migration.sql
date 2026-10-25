CREATE TABLE `project_deletion` (
	`project_id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `project_retention` (
	`project_id` text PRIMARY KEY,
	`cursor` text,
	`scanned_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_deletion_pending` ON `project_deletion` (`completed_at`,`requested_at`);
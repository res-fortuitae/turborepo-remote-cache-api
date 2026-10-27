CREATE TABLE `artifact_signing_key` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`envelope` text NOT NULL,
	`created_at` integer NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE TABLE `artifact_signing_settings` (
	`project_id` text PRIMARY KEY,
	`required` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifact_signing_project` ON `artifact_signing_key` (`project_id`,`created_at`);
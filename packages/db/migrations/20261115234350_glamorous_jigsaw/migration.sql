ALTER TABLE `project_deletion` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_deletion` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_deletion` ADD `last_error` text;
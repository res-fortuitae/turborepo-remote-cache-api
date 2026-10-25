CREATE TABLE `artifact_purge_job` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`state` text NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL
);

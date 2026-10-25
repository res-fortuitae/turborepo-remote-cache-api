CREATE TABLE `artifact_operation` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`provenance` text NOT NULL
);

CREATE TABLE `auth_audit_intent` (
	`id` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	`model` text NOT NULL,
	`target_id` text NOT NULL,
	`operation` text NOT NULL,
	`fields` text NOT NULL,
	`digest` text,
	`event` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_audit_intent_pending` ON `auth_audit_intent` (`created_at`);
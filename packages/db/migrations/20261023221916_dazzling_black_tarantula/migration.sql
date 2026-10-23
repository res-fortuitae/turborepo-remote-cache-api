ALTER TABLE `audit_event` ADD `chain` text;--> statement-breakpoint
ALTER TABLE `audit_event` ADD `sequence` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_event_chain` ON `audit_event` (`chain`,`sequence`);
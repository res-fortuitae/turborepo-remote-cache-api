CREATE TABLE `invitation_claim` (
	`invitation_id` text PRIMARY KEY,
	`nonce` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitation_window` (
	`key` text PRIMARY KEY,
	`count` integer NOT NULL
);

CREATE TABLE `oidc_jti` (
	`issuer` text NOT NULL,
	`jti` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `oidc_jti_pk` PRIMARY KEY(`issuer`, `jti`)
);
--> statement-breakpoint
CREATE INDEX `oidc_jti_expiry` ON `oidc_jti` (`expires_at`);
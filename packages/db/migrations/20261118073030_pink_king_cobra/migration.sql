CREATE INDEX `anomaly_incident_project_created_at` ON `anomaly_incident` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifact_operation_created_at` ON `artifact_operation` (`created_at`);--> statement-breakpoint
CREATE INDEX `artifact_purge_job_state` ON `artifact_purge_job` (`state`);--> statement-breakpoint
CREATE INDEX `notification_user_kind_created_at` ON `notification` (`user_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_created_at` ON `notification` (`created_at`);
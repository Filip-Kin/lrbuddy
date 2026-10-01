CREATE TABLE `client_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`url` text,
	`user_agent` text,
	`role` text
);
--> statement-breakpoint
CREATE INDEX `client_errors_at_idx` ON `client_errors` (`at`);
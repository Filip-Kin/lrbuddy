CREATE TABLE `invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`role` text NOT NULL,
	`event_id` integer,
	`day_id` integer,
	`cc_id` integer,
	`crew_id` integer,
	`truck_id` integer,
	`name` text,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by_user_id` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE INDEX `invites_cc_idx` ON `invites` (`cc_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`event_id` integer,
	`role` text NOT NULL,
	`day_id` integer,
	`cc_id` integer,
	`crew_id` integer,
	`truck_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by_user_id` integer,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_memberships`("id", "user_id", "event_id", "role", "day_id", "cc_id", "crew_id", "truck_id", "status", "requested_at", "decided_at", "decided_by_user_id", "note") SELECT "id", "user_id", "event_id", "role", "day_id", "cc_id", "crew_id", "truck_id", "status", "requested_at", "decided_at", "decided_by_user_id", "note" FROM `memberships`;--> statement-breakpoint
-- Dropping memberships runs ON DELETE SET NULL on sessions.membership_id even here: PRAGMA
-- foreign_keys=OFF does nothing inside the migration transaction. Keep the links and put them back.
CREATE TEMP TABLE `_session_memberships` AS SELECT `id`, `membership_id` FROM `sessions` WHERE `membership_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `memberships`;--> statement-breakpoint
ALTER TABLE `__new_memberships` RENAME TO `memberships`;--> statement-breakpoint
UPDATE `sessions` SET `membership_id` = (SELECT `membership_id` FROM `_session_memberships` WHERE `_session_memberships`.`id` = `sessions`.`id`) WHERE `id` IN (SELECT `id` FROM `_session_memberships`);--> statement-breakpoint
DROP TABLE `_session_memberships`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_cc_status_idx` ON `memberships` (`cc_id`,`status`);
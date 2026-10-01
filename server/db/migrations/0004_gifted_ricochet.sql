CREATE TABLE `memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`event_id` integer NOT NULL,
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
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_cc_status_idx` ON `memberships` (`cc_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`firebase_uid` text NOT NULL,
	`name` text,
	`phone` text,
	`email` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_firebase_uid_unique` ON `users` (`firebase_uid`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` integer REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `sessions` ADD `membership_id` integer REFERENCES memberships(id) ON DELETE set null;
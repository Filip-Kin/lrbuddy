CREATE TABLE `tire_piles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`cc_id` integer NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`role` text NOT NULL,
	`crew_id` integer,
	`truck_id` integer,
	`made_by` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	`moved_at` integer,
	`photo_at` integer,
	`photo_by` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tire_piles_cc_idx` ON `tire_piles` (`cc_id`);
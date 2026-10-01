CREATE TABLE `lot_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lot_id` integer NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`taken_by` text,
	`role` text NOT NULL,
	`crew_id` integer,
	`truck_id` integer,
	`cc_id` integer,
	`day_id` integer,
	`at` integer NOT NULL,
	`lat` real,
	`lng` real,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `lot_photos_lot_idx` ON `lot_photos` (`lot_id`);--> statement-breakpoint
CREATE INDEX `lot_photos_day_cc_idx` ON `lot_photos` (`day_id`,`cc_id`);
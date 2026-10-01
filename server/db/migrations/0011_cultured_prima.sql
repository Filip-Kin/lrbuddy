CREATE TABLE `alleys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`cc_id` integer NOT NULL,
	`osm_id` integer NOT NULL,
	`polygon` text NOT NULL,
	`centerline` text NOT NULL,
	`between_street_1` text,
	`between_street_2` text,
	`from_cross` text,
	`to_cross` text,
	`status` text DEFAULT 'open' NOT NULL,
	`crew_id` integer,
	`status_at` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alleys_cc_osm_idx` ON `alleys` (`cc_id`,`osm_id`);--> statement-breakpoint
CREATE INDEX `alleys_day_idx` ON `alleys` (`day_id`);
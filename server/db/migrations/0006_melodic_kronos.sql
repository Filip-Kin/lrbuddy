CREATE TABLE `crew_areas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`polygon` text,
	`label` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `crew_areas_day_idx` ON `crew_areas` (`day_id`);--> statement-breakpoint
ALTER TABLE `assignments` ADD `area_id` integer REFERENCES crew_areas(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `command_centers` ADD `letter` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `short` text;--> statement-breakpoint
ALTER TABLE `crews` ADD `area_id` integer REFERENCES crew_areas(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `crews` DROP COLUMN `area`;
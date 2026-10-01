CREATE TABLE `assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`cc_id` integer NOT NULL,
	`company_id` integer,
	`crew_id` integer,
	`block_side_key` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_event_key` ON `assignments` (`event_id`,`block_side_key`);--> statement-breakpoint
CREATE INDEX `assignments_day_cc_idx` ON `assignments` (`day_id`,`cc_id`);--> statement-breakpoint
CREATE TABLE `company_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`cc_id` integer,
	`headcount` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_days_company_day` ON `company_days` (`company_id`,`day_id`);--> statement-breakpoint
CREATE TABLE `parcels` (
	`parcel_id` text PRIMARY KEY NOT NULL,
	`address` text,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`geometry` text NOT NULL,
	`street_name` text,
	`street_number` integer,
	`street_prefix` text,
	`cross_street_1` text,
	`cross_street_2` text,
	`property_class` text,
	`property_class_description` text,
	`taxpayer_1` text,
	`is_improved` integer,
	`pct_pre_claimed` real,
	`sale_date` text,
	`block_side_key` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `parcels_lat_lng_idx` ON `parcels` (`lat`,`lng`);--> statement-breakpoint
CREATE INDEX `parcels_block_side_idx` ON `parcels` (`block_side_key`);--> statement-breakpoint
CREATE TABLE `survey_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`parcel_id` text NOT NULL,
	`grade` text NOT NULL,
	`side` text NOT NULL,
	`note` text,
	`lat` real,
	`lng` real,
	`heading` real,
	`by` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `survey_tags_event_parcel_at` ON `survey_tags` (`event_id`,`parcel_id`,`at`);--> statement-breakpoint
ALTER TABLE `crews` ADD `area` text;
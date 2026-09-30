CREATE TABLE `broadcasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cc_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`body` text NOT NULL,
	`sent_by` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `broadcasts_cc_idx` ON `broadcasts` (`cc_id`);--> statement-breakpoint
CREATE TABLE `command_centers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`address` text,
	`notes` text,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cc_day_idx` ON `command_centers` (`day_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `companies_event_idx` ON `companies` (`event_id`);--> statement-breakpoint
CREATE TABLE `crews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`cc_id` integer NOT NULL,
	`company_id` integer,
	`number` integer NOT NULL,
	`lead_name` text,
	`lead_phone` text,
	`token` text NOT NULL,
	`headcount` integer,
	`notes` text,
	`last_seen_at` integer,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crews_token_unique` ON `crews` (`token`);--> statement-breakpoint
CREATE INDEX `crews_day_idx` ON `crews` (`day_id`);--> statement-breakpoint
CREATE INDEX `crews_cc_idx` ON `crews` (`cc_id`);--> statement-breakpoint
CREATE TABLE `days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`date` text NOT NULL,
	`label` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `days_event_idx` ON `days` (`event_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`year` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `green_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cc_id` integer NOT NULL,
	`code` text NOT NULL,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `green_codes_cc_id_unique` ON `green_codes` (`cc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `green_codes_code_unique` ON `green_codes` (`code`);--> statement-breakpoint
CREATE TABLE `green_shirts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cc_id` integer NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`role_label` text,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `green_shirts_cc_idx` ON `green_shirts` (`cc_id`);--> statement-breakpoint
CREATE TABLE `lots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`parcel_id` text,
	`address` text,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`source` text NOT NULL,
	`cc_id` integer,
	`crew_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`status_by_crew_id` integer,
	`status_at` integer,
	`note` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`status_by_crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lots_event_parcel` ON `lots` (`event_id`,`parcel_id`) WHERE parcel_id is not null;--> statement-breakpoint
CREATE INDEX `lots_cc_idx` ON `lots` (`cc_id`);--> statement-breakpoint
CREATE INDEX `lots_crew_idx` ON `lots` (`crew_id`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`accuracy` real,
	`heading` real,
	`speed` real,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `positions_kind_ref_at` ON `positions` (`kind`,`ref_id`,"at" desc);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `request_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`unit` text NOT NULL,
	`priority` integer DEFAULT 2 NOT NULL,
	`tracks_stock` integer DEFAULT true NOT NULL,
	`default_capacity` integer DEFAULT 0 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_types_event_key` ON `request_types` (`event_id`,`key`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`crew_id` integer,
	`cc_id` integer NOT NULL,
	`day_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`qty` integer DEFAULT 1 NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'open' NOT NULL,
	`truck_id` integer,
	`created_at` integer NOT NULL,
	`assigned_at` integer,
	`en_route_at` integer,
	`delivered_at` integer,
	`cancelled_at` integer,
	`cancelled_by` text,
	`cancel_note` text,
	`lat` real,
	`lng` real,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `request_types`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `requests_cc_day_idx` ON `requests` (`cc_id`,`day_id`);--> statement-breakpoint
CREATE INDEX `requests_truck_idx` ON `requests` (`truck_id`);--> statement-breakpoint
CREATE INDEX `requests_crew_idx` ON `requests` (`crew_id`);--> statement-breakpoint
CREATE TABLE `routes` (
	`truck_id` integer PRIMARY KEY NOT NULL,
	`computed_at` integer NOT NULL,
	`stop_order` text NOT NULL,
	`geometry` text NOT NULL,
	`legs` text NOT NULL,
	`distance_m` real NOT NULL,
	`duration_s` real NOT NULL,
	`ends_at_cc` integer DEFAULT false NOT NULL,
	`engine` text NOT NULL,
	`origin_lat` real NOT NULL,
	`origin_lng` real NOT NULL,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`crew_id` integer,
	`truck_id` integer,
	`cc_id` integer,
	`display_name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stock_moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`truck_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`request_id` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `request_types`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stock_moves_truck_idx` ON `stock_moves` (`truck_id`);--> statement-breakpoint
CREATE TABLE `truck_stock` (
	`truck_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`qty` integer DEFAULT 0 NOT NULL,
	`capacity` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`truck_id`, `type_id`),
	FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `request_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trucks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`cc_id` integer NOT NULL,
	`name` text NOT NULL,
	`driver_name` text,
	`driver_phone` text,
	`code` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cc_id`) REFERENCES `command_centers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trucks_code_unique` ON `trucks` (`code`);--> statement-breakpoint
CREATE INDEX `trucks_cc_idx` ON `trucks` (`cc_id`);
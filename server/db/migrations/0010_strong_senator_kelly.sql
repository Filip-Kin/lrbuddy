CREATE TABLE `oneway_ways` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bbox_key` text NOT NULL,
	`osm_id` integer NOT NULL,
	`geometry` text NOT NULL,
	`direction` integer NOT NULL,
	`name` text,
	`min_lat` real NOT NULL,
	`min_lng` real NOT NULL,
	`max_lat` real NOT NULL,
	`max_lng` real NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oneway_ways_bbox_key_idx` ON `oneway_ways` (`bbox_key`);--> statement-breakpoint
CREATE INDEX `oneway_ways_bounds_idx` ON `oneway_ways` (`min_lat`,`max_lat`);
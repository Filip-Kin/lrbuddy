CREATE TABLE `osm_alleys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`osm_id` integer NOT NULL,
	`centerline` text NOT NULL,
	`min_lat` real NOT NULL,
	`min_lng` real NOT NULL,
	`max_lat` real NOT NULL,
	`max_lng` real NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osm_alleys_osm_idx` ON `osm_alleys` (`osm_id`);--> statement-breakpoint
CREATE INDEX `osm_alleys_bounds_idx` ON `osm_alleys` (`min_lat`,`max_lat`);--> statement-breakpoint
-- Keep the centrelines already fetched as hints; statuses and crews go with the table (SPEC 24).
INSERT OR IGNORE INTO `osm_alleys` (`osm_id`, `centerline`, `min_lat`, `min_lng`, `max_lat`, `max_lng`, `fetched_at`)
SELECT a.`osm_id`, a.`centerline`,
  (SELECT min(json_extract(value, '$[0]')) FROM json_each(a.`centerline`)),
  (SELECT min(json_extract(value, '$[1]')) FROM json_each(a.`centerline`)),
  (SELECT max(json_extract(value, '$[0]')) FROM json_each(a.`centerline`)),
  (SELECT max(json_extract(value, '$[1]')) FROM json_each(a.`centerline`)),
  a.`fetched_at`
FROM `alleys` a;--> statement-breakpoint
DROP TABLE `alleys`;
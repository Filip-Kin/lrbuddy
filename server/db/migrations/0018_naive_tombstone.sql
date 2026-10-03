ALTER TABLE `lots` ADD `alley_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `lots_event_alley` ON `lots` (`event_id`,`alley_key`) WHERE alley_key is not null;
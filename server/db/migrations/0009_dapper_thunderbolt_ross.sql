ALTER TABLE `lots` ADD `grade` text;--> statement-breakpoint
UPDATE `lots` SET `status` = 'do_not_touch' WHERE `status` = 'skipped';

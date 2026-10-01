ALTER TABLE `crews` ADD `name` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `crews` SET `name` = 'Crew ' || `number` WHERE `company_id` IS NULL;--> statement-breakpoint
UPDATE `crews` SET `name` = (
  SELECT CASE
      WHEN TRIM(COALESCE(co.`short`, '')) <> '' THEN TRIM(co.`short`)
      WHEN INSTR(TRIM(co.`name`), ' ') > 0 THEN SUBSTR(TRIM(co.`name`), 1, INSTR(TRIM(co.`name`), ' ') - 1)
      ELSE TRIM(co.`name`)
    END
  FROM `companies` co WHERE co.`id` = `crews`.`company_id`
) || ' ' || (
  SELECT COUNT(*) FROM `crews` c2
  WHERE c2.`day_id` = `crews`.`day_id` AND c2.`company_id` = `crews`.`company_id`
    AND (c2.`number` < `crews`.`number` OR (c2.`number` = `crews`.`number` AND c2.`id` <= `crews`.`id`))
) WHERE `company_id` IS NOT NULL;

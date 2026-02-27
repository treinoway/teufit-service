-- Step 1: Add week_day column (nullable) to trainings
ALTER TABLE "trainings" ADD COLUMN "week_day" TEXT;

-- Step 2: Migrate data - copy week_day from first schedule (lowest order) to each training
UPDATE "trainings" t
SET "week_day" = s."week_day"
FROM (
  SELECT DISTINCT ON ("training_id") "training_id", "week_day"
  FROM "training_schedules"
  ORDER BY "training_id", "order" ASC
) s
WHERE t."id" = s."training_id";

-- Step 3: Drop training_schedules (has FKs to trainings and training_protocols)
DROP TABLE "training_schedules";

-- Step 4: Rename training_schedule_templates to protocol_template_trainings
ALTER TABLE "training_schedule_templates" RENAME TO "protocol_template_trainings";

-- Step 5: Make week_day nullable in protocol_template_trainings
ALTER TABLE "protocol_template_trainings" ALTER COLUMN "week_day" DROP NOT NULL;

-- Step 6: Remove available_week_days from training_protocols
ALTER TABLE "training_protocols" DROP COLUMN "available_week_days";

-- Step 7: Remove available_week_days from training_protocol_templates
ALTER TABLE "training_protocol_templates" DROP COLUMN "available_week_days";

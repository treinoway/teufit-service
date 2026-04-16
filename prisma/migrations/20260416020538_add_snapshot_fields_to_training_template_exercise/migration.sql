-- DropIndex
DROP INDEX "training_template_exercise_templates_training_template_id_e_key";

-- AlterTable: add nullable columns first so UPDATE can populate existing rows
ALTER TABLE "training_template_exercise_templates"
ADD COLUMN "duration" INTEGER,
ADD COLUMN "has_load" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "name" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "repetitions" JSONB,
ADD COLUMN "rest_interval" INTEGER,
ADD COLUMN "sets" INTEGER,
ADD COLUMN "suggested_load" DOUBLE PRECISION,
ADD COLUMN "type" TEXT,
ADD COLUMN "video_url" TEXT;

-- Backfill snapshot fields from exercise_templates for existing rows
UPDATE "training_template_exercise_templates" ttet
SET
  "name" = et."name",
  "type" = et."type",
  "video_url" = et."video_url",
  "sets" = et."sets",
  "repetitions" = et."repetitions",
  "duration" = et."duration",
  "has_load" = et."has_load",
  "suggested_load" = et."suggested_load",
  "rest_interval" = et."rest_interval",
  "notes" = et."notes"
FROM "exercise_templates" et
WHERE ttet."exercise_template_id" = et."id";

-- AlterTable: enforce NOT NULL after backfill
ALTER TABLE "training_template_exercise_templates"
ALTER COLUMN "name" SET NOT NULL,
ALTER COLUMN "type" SET NOT NULL;

-- CreateIndex
CREATE INDEX "training_template_exercise_templates_training_template_id_idx" ON "training_template_exercise_templates"("training_template_id");

-- CreateIndex
CREATE INDEX "training_template_exercise_templates_exercise_template_id_idx" ON "training_template_exercise_templates"("exercise_template_id");

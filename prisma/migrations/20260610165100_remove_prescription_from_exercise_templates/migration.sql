-- Library exercise templates carry only the exercise identity (name, type, video).
-- Prescription ("how it's done") lives on the TrainingTemplateExerciseTemplate junction
-- and the real Exercise — not on the reusable library template.
-- AlterTable
ALTER TABLE "exercise_templates" DROP COLUMN "duration",
DROP COLUMN "has_load",
DROP COLUMN "intensity",
DROP COLUMN "notes",
DROP COLUMN "prescription_mode",
DROP COLUMN "repetitions",
DROP COLUMN "rest_interval",
DROP COLUMN "sets",
DROP COLUMN "suggested_load";

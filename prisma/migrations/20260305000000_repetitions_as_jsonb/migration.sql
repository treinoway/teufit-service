-- AlterTable: change repetitions from INTEGER to JSONB in exercise_templates
ALTER TABLE "exercise_templates" DROP COLUMN "repetitions";
ALTER TABLE "exercise_templates" ADD COLUMN "repetitions" JSONB;

-- AlterTable: change repetitions from INTEGER to JSONB in exercises
ALTER TABLE "exercises" DROP COLUMN "repetitions";
ALTER TABLE "exercises" ADD COLUMN "repetitions" JSONB;

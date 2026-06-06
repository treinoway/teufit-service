-- AlterTable
ALTER TABLE "exercise_templates" ADD COLUMN     "intensity" TEXT;

-- AlterTable
ALTER TABLE "exercises" ADD COLUMN     "intensity" TEXT;

-- AlterTable
ALTER TABLE "training_template_exercise_templates" ADD COLUMN     "intensity" TEXT;

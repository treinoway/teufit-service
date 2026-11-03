-- AlterTable
ALTER TABLE "exercise_templates" ADD COLUMN "video_file_key" TEXT;
ALTER TABLE "training_template_exercise_templates" ADD COLUMN "video_file_key" TEXT;
ALTER TABLE "exercises" ADD COLUMN "video_file_key" TEXT;

-- Optional GIF demonstration link for exercises (video takes precedence in clients).
ALTER TABLE "exercise_templates" ADD COLUMN "gif_url" TEXT;
ALTER TABLE "training_template_exercise_templates" ADD COLUMN "gif_url" TEXT;
ALTER TABLE "exercises" ADD COLUMN "gif_url" TEXT;

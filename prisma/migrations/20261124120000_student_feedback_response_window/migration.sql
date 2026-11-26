-- AlterTable: days a student has to answer a feedback, per trainer (1-7). Existing rows take the default, the window used until now.
ALTER TABLE "student_feedback_configs" ADD COLUMN "response_window_days" INTEGER NOT NULL DEFAULT 3;

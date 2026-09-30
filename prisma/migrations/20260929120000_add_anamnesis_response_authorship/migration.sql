-- Authorship of an anamnesis response: filled by the student (default, also for every
-- pre-existing row) or by the trainer on the student's behalf.
-- filled_by_role is stored on its own (not derived from filled_by_user_id) because the
-- FK below is ON DELETE SET NULL: deleting the filler's user must not turn a
-- trainer-filled response into an "authorless" one.
-- No backfill: legacy rows keep role 'student' with student_confirmed_at NULL, which the
-- derived status treats as "submitted" (only trainer-filled rows can be "awaiting confirmation").

-- AlterTable
ALTER TABLE "anamnesis_responses"
  ADD COLUMN "filled_by_role" TEXT NOT NULL DEFAULT 'student',
  ADD COLUMN "filled_by_user_id" UUID,
  ADD COLUMN "trainer_attested_at" TIMESTAMPTZ(6),
  ADD COLUMN "student_confirmed_at" TIMESTAMPTZ(6);

-- AddForeignKey
ALTER TABLE "anamnesis_responses" ADD CONSTRAINT "anamnesis_responses_filled_by_user_id_fkey" FOREIGN KEY ("filled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

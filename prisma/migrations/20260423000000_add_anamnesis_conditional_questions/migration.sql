-- AlterTable
ALTER TABLE "anamnesis_questions" ADD COLUMN "parent_question_id" UUID,
ADD COLUMN "condition" JSONB;

-- AddForeignKey
ALTER TABLE "anamnesis_questions" ADD CONSTRAINT "anamnesis_questions_parent_question_id_fkey"
  FOREIGN KEY ("parent_question_id")
  REFERENCES "anamnesis_questions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "anamnesis_questions_parent_question_id_idx" ON "anamnesis_questions"("parent_question_id");

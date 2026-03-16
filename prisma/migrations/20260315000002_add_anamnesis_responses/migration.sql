-- CreateTable
CREATE TABLE "anamnesis_responses" (
    "id" UUID NOT NULL,
    "anamnesis_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "anamnesis_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anamnesis_answers" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "anamnesis_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anamnesis_responses_anamnesis_id_student_id_key" ON "anamnesis_responses"("anamnesis_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "anamnesis_answers_response_id_question_id_key" ON "anamnesis_answers"("response_id", "question_id");

-- AddForeignKey
ALTER TABLE "anamnesis_responses" ADD CONSTRAINT "anamnesis_responses_anamnesis_id_fkey" FOREIGN KEY ("anamnesis_id") REFERENCES "anamneses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anamnesis_responses" ADD CONSTRAINT "anamnesis_responses_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anamnesis_answers" ADD CONSTRAINT "anamnesis_answers_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "anamnesis_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anamnesis_answers" ADD CONSTRAINT "anamnesis_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "anamnesis_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

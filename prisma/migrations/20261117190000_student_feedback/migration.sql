-- CreateTable
CREATE TABLE "student_feedback_templates" (
    "id" UUID NOT NULL,
    "trainer_id" UUID,
    "name" TEXT NOT NULL,
    "is_general" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_feedback_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_feedback_questions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "help_text" TEXT,
    "type" TEXT NOT NULL,
    "pillar" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "min_label" TEXT,
    "max_label" TEXT,
    "invert_score" BOOLEAN NOT NULL DEFAULT false,
    "condition" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_feedback_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_feedback_configs" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "auto_send_enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_at" TIMESTAMPTZ(6),
    "d7" BOOLEAN NOT NULL DEFAULT true,
    "d15" BOOLEAN NOT NULL DEFAULT true,
    "d21" BOOLEAN NOT NULL DEFAULT true,
    "d30" BOOLEAN NOT NULL DEFAULT true,
    "recurring" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_feedback_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_feedback_requests" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "milestone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "has_meal_plan" BOOLEAN NOT NULL DEFAULT false,
    "due_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "reminder_sent_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "overall_index" INTEGER,
    "band" TEXT,
    "pillar_scores" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_feedback_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_feedback_answers" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "score" INTEGER,
    "text" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_feedback_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_feedback_templates_trainer_id_idx" ON "student_feedback_templates"("trainer_id");

-- CreateIndex
CREATE INDEX "student_feedback_questions_template_id_order_idx" ON "student_feedback_questions"("template_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "student_feedback_configs_trainer_id_key" ON "student_feedback_configs"("trainer_id");

-- CreateIndex
CREATE INDEX "student_feedback_requests_trainer_id_sent_at_idx" ON "student_feedback_requests"("trainer_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "student_feedback_requests_student_id_status_idx" ON "student_feedback_requests"("student_id", "status");

-- CreateIndex
CREATE INDEX "student_feedback_requests_status_expires_at_idx" ON "student_feedback_requests"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_feedback_requests_trainer_id_student_id_due_at_key" ON "student_feedback_requests"("trainer_id", "student_id", "due_at");

-- CreateIndex
CREATE INDEX "student_feedback_answers_question_id_idx" ON "student_feedback_answers"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_feedback_answers_request_id_question_id_key" ON "student_feedback_answers"("request_id", "question_id");

-- AddForeignKey
ALTER TABLE "student_feedback_templates" ADD CONSTRAINT "student_feedback_templates_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_templates" ADD CONSTRAINT "student_feedback_templates_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "student_feedback_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_questions" ADD CONSTRAINT "student_feedback_questions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "student_feedback_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_configs" ADD CONSTRAINT "student_feedback_configs_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_requests" ADD CONSTRAINT "student_feedback_requests_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_requests" ADD CONSTRAINT "student_feedback_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_requests" ADD CONSTRAINT "student_feedback_requests_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "student_feedback_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_answers" ADD CONSTRAINT "student_feedback_answers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "student_feedback_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback_answers" ADD CONSTRAINT "student_feedback_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "student_feedback_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Seed: general template "Padrão TeuFit" (trainer_id NULL) with its 8 questions
WITH template AS (
    INSERT INTO "student_feedback_templates" ("id", "trainer_id", "name", "is_general", "version")
    SELECT gen_random_uuid(), NULL, 'Padrão TeuFit', true, 1
    WHERE NOT EXISTS (SELECT 1 FROM "student_feedback_templates" WHERE "is_general" = true)
    RETURNING "id"
)
INSERT INTO "student_feedback_questions"
    ("id", "template_id", "order", "text", "help_text", "type", "pillar", "required", "min_label", "max_label", "invert_score", "condition")
SELECT gen_random_uuid(), template."id", question."order", question."text", question."help_text", question."type", question."pillar", question."required", question."min_label", question."max_label", false, question."condition"
FROM template
CROSS JOIN (VALUES
    (1, 'De 0 a 10, quanto do treino proposto rolou nesses últimos dias?', NULL, 'score', 'training_adherence', true, 'não rolou nada', 'fiz tudo', NULL),
    (2, 'De 0 a 10, quanto do plano alimentar tu conseguiu seguir?', NULL, 'score', 'diet_adherence', true, 'não segui nada', 'segui tudo', 'has_meal_plan'),
    (3, 'Como tá tua evolução até aqui?', 'Força, disposição, medidas, como a roupa veste. Vale o que fizer sentido pra ti.', 'stars', 'evolution', true, NULL, NULL, NULL),
    (4, 'De 0 a 10, quanto o plano coube na tua rotina?', NULL, 'score', 'routine', true, 'não coube', 'coube certinho', NULL),
    (5, 'O que não encaixou na tua rotina?', 'Horário, treino longo, comida, cansaço, viagem... Conta aqui que teu personal ajusta.', 'open', 'routine', false, NULL, NULL, NULL),
    (6, 'Como tá teu sono?', NULL, 'stars', 'sleep', true, NULL, NULL, NULL),
    (7, 'De 0 a 10, como tá tua água?', NULL, 'score', 'hydration', true, 'quase não bebi', 'bebi o suficiente todo dia', NULL),
    (8, 'Quer contar mais alguma coisa sobre teu processo?', NULL, 'open', 'report', false, NULL, NULL, NULL)
) AS question("order", "text", "help_text", "type", "pillar", "required", "min_label", "max_label", "condition");


-- CreateTable
CREATE TABLE "advanced_techniques" (
    "id" UUID NOT NULL,
    "trainer_id" UUID,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "video_url" TEXT,
    "gif_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "advanced_techniques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_advanced_techniques" (
    "id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "advanced_technique_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exercise_advanced_techniques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_template_advanced_techniques" (
    "id" UUID NOT NULL,
    "exercise_template_id" UUID NOT NULL,
    "advanced_technique_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exercise_template_advanced_techniques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_template_exercise_advanced_techniques" (
    "id" UUID NOT NULL,
    "training_template_exercise_template_id" UUID NOT NULL,
    "advanced_technique_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "training_template_exercise_advanced_techniques_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "advanced_techniques_key_key" ON "advanced_techniques"("key");

-- CreateIndex
CREATE INDEX "advanced_techniques_trainer_id_deleted_at_idx" ON "advanced_techniques"("trainer_id", "deleted_at");

-- CreateIndex
CREATE INDEX "exercise_advanced_techniques_advanced_technique_id_idx" ON "exercise_advanced_techniques"("advanced_technique_id");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_advanced_techniques_exercise_id_advanced_technique_key" ON "exercise_advanced_techniques"("exercise_id", "advanced_technique_id");

-- CreateIndex
CREATE INDEX "exercise_template_advanced_techniques_advanced_technique_id_idx" ON "exercise_template_advanced_techniques"("advanced_technique_id");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_template_advanced_techniques_exercise_template_id__key" ON "exercise_template_advanced_techniques"("exercise_template_id", "advanced_technique_id");

-- CreateIndex
CREATE INDEX "training_template_exercise_advanced_techniques_advanced_tec_idx" ON "training_template_exercise_advanced_techniques"("advanced_technique_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_template_exercise_advanced_techniques_training_tem_key" ON "training_template_exercise_advanced_techniques"("training_template_exercise_template_id", "advanced_technique_id");

-- AddForeignKey
ALTER TABLE "advanced_techniques" ADD CONSTRAINT "advanced_techniques_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_advanced_techniques" ADD CONSTRAINT "exercise_advanced_techniques_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_advanced_techniques" ADD CONSTRAINT "exercise_advanced_techniques_advanced_technique_id_fkey" FOREIGN KEY ("advanced_technique_id") REFERENCES "advanced_techniques"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_template_advanced_techniques" ADD CONSTRAINT "exercise_template_advanced_techniques_exercise_template_id_fkey" FOREIGN KEY ("exercise_template_id") REFERENCES "exercise_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_template_advanced_techniques" ADD CONSTRAINT "exercise_template_advanced_techniques_advanced_technique_i_fkey" FOREIGN KEY ("advanced_technique_id") REFERENCES "advanced_techniques"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_template_exercise_advanced_techniques" ADD CONSTRAINT "training_template_exercise_advanced_techniques_training_te_fkey" FOREIGN KEY ("training_template_exercise_template_id") REFERENCES "training_template_exercise_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_template_exercise_advanced_techniques" ADD CONSTRAINT "training_template_exercise_advanced_techniques_advanced_te_fkey" FOREIGN KEY ("advanced_technique_id") REFERENCES "advanced_techniques"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed system techniques (trainer_id NULL, stable key); idempotent.
INSERT INTO "advanced_techniques" ("id", "trainer_id", "key", "name", "description")
VALUES
  (gen_random_uuid(), NULL, 'drop_set', 'Drop set', 'Ao atingir a falha, reduza a carga em 20–30% e continue imediatamente, sem descanso. Pode repetir a redução 1–2 vezes.'),
  (gen_random_uuid(), NULL, 'rest_pause', 'Rest-pause', 'Ao atingir a falha, descanse 10–20 segundos e faça mais algumas repetições com a mesma carga. Repita 1–2 vezes.'),
  (gen_random_uuid(), NULL, 'cluster_set', 'Cluster set', 'Divida a série em pequenos blocos de repetições com pausas curtas (10–30s) entre eles, mantendo carga alta e técnica limpa, sem chegar à falha.'),
  (gen_random_uuid(), NULL, 'peak_contraction', 'Pico de contração', 'Em cada repetição, segure 1 a 3 segundos na posição de contração máxima antes de iniciar a volta.')
ON CONFLICT ("key") DO NOTHING;

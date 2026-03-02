-- CreateTable
CREATE TABLE "training_template_exercise_templates" (
    "id" UUID NOT NULL,
    "training_template_id" UUID NOT NULL,
    "exercise_template_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "training_template_exercise_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "training_template_exercise_templates_training_template_id_e_key" ON "training_template_exercise_templates"("training_template_id", "exercise_template_id");

-- AddForeignKey
ALTER TABLE "training_template_exercise_templates" ADD CONSTRAINT "training_template_exercise_templates_training_template_id_fkey" FOREIGN KEY ("training_template_id") REFERENCES "training_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_template_exercise_templates" ADD CONSTRAINT "training_template_exercise_templates_exercise_template_id_fkey" FOREIGN KEY ("exercise_template_id") REFERENCES "exercise_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

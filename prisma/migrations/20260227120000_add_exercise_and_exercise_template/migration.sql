-- CreateTable
CREATE TABLE "exercise_templates" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "video_url" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "sets" INTEGER,
    "repetitions" INTEGER,
    "duration" INTEGER,
    "has_load" BOOLEAN NOT NULL DEFAULT false,
    "suggested_load" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "exercise_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercises" (
    "id" UUID NOT NULL,
    "training_id" UUID NOT NULL,
    "exercise_template_id" UUID,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "video_url" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "sets" INTEGER,
    "repetitions" INTEGER,
    "duration" INTEGER,
    "has_load" BOOLEAN NOT NULL DEFAULT false,
    "suggested_load" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "exercises_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "exercise_templates" ADD CONSTRAINT "exercise_templates_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_exercise_template_id_fkey" FOREIGN KEY ("exercise_template_id") REFERENCES "exercise_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

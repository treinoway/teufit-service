-- CreateTable
CREATE TABLE "training_protocol_templates" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "available_week_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "default_duration_weeks" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "training_protocol_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_protocols" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "protocol_template_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "available_week_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "start_date" DATE NOT NULL,
    "expiration_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "training_protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_templates" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "body_segment" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "training_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trainings" (
    "id" UUID NOT NULL,
    "training_protocol_id" UUID NOT NULL,
    "training_template_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "body_segment" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "trainings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_schedules" (
    "id" UUID NOT NULL,
    "training_protocol_id" UUID NOT NULL,
    "training_id" UUID NOT NULL,
    "week_day" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "training_schedules_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "training_protocol_templates" ADD CONSTRAINT "training_protocol_templates_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_protocols" ADD CONSTRAINT "training_protocols_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_protocols" ADD CONSTRAINT "training_protocols_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_protocols" ADD CONSTRAINT "training_protocols_protocol_template_id_fkey" FOREIGN KEY ("protocol_template_id") REFERENCES "training_protocol_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_templates" ADD CONSTRAINT "training_templates_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_training_protocol_id_fkey" FOREIGN KEY ("training_protocol_id") REFERENCES "training_protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_training_template_id_fkey" FOREIGN KEY ("training_template_id") REFERENCES "training_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_schedules" ADD CONSTRAINT "training_schedules_training_protocol_id_fkey" FOREIGN KEY ("training_protocol_id") REFERENCES "training_protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_schedules" ADD CONSTRAINT "training_schedules_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

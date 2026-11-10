-- AlterTable
ALTER TABLE "consistency_ranking_configs" ADD COLUMN     "batch_count" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "batch_minutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "min_workout_minutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "risk_limit" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN     "risk_weeks" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "consistency_weekly_targets" ADD COLUMN     "adjusted" INTEGER,
ADD COLUMN     "adjusted_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "consistency_contact_logs" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "pillar" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consistency_contact_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consistency_contact_logs_trainer_id_student_id_created_at_idx" ON "consistency_contact_logs"("trainer_id", "student_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "consistency_contact_logs" ADD CONSTRAINT "consistency_contact_logs_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_contact_logs" ADD CONSTRAINT "consistency_contact_logs_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

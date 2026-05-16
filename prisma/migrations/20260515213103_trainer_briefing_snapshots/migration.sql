-- CreateTable
CREATE TABLE "trainer_briefing_snapshots" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "active_students" INTEGER NOT NULL,
    "returning_this_week" INTEGER NOT NULL,
    "stagnant_progress" INTEGER NOT NULL,
    "inactive_students" INTEGER NOT NULL,
    "overall_adherence" DECIMAL(5,2) NOT NULL,
    "adherence_delta_pp" DECIMAL(5,2) NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "is_dirty" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trainer_briefing_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trainer_briefing_snapshots_trainer_id_key" ON "trainer_briefing_snapshots"("trainer_id");

-- AddForeignKey
ALTER TABLE "trainer_briefing_snapshots" ADD CONSTRAINT "trainer_briefing_snapshots_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

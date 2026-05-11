-- AlterTable
ALTER TABLE "exercise_logs" ADD COLUMN     "substituted_by_exercise_id" UUID;

-- AlterTable
ALTER TABLE "exercises" ADD COLUMN     "substitute_for_exercise_id" UUID,
ADD COLUMN     "substitute_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "superset_group_id" UUID,
ADD COLUMN     "superset_order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "training_template_exercise_templates" ADD COLUMN     "superset_group_id" UUID,
ADD COLUMN     "superset_order" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "exercises_training_id_superset_group_id_idx" ON "exercises"("training_id", "superset_group_id");

-- CreateIndex
CREATE INDEX "exercises_substitute_for_exercise_id_idx" ON "exercises"("substitute_for_exercise_id");

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_substitute_for_exercise_id_fkey" FOREIGN KEY ("substitute_for_exercise_id") REFERENCES "exercises"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

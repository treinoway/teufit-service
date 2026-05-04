-- CreateIndex
CREATE INDEX "exercises_training_id_idx" ON "exercises"("training_id");

-- CreateIndex
CREATE INDEX "training_protocols_assignee_id_status_start_date_idx" ON "training_protocols"("assignee_id", "status", "start_date" DESC);

-- CreateIndex
CREATE INDEX "training_protocols_trainer_id_idx" ON "training_protocols"("trainer_id");

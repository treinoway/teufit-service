-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "trainings_training_protocol_id_idx" ON "trainings"("training_protocol_id");

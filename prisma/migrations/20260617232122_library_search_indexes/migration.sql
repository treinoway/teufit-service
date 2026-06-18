-- Enable pg_trgm extension for trigram-based ILIKE search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for ILIKE name search on the 3 library tables
CREATE INDEX IF NOT EXISTS idx_exercise_templates_name_trgm ON "exercise_templates" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_training_templates_name_trgm ON "training_templates" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_training_protocol_templates_name_trgm ON "training_protocol_templates" USING gin ("name" gin_trgm_ops);

-- CreateIndex — composite btree for list WHERE clauses
CREATE INDEX "exercise_templates_trainer_id_deleted_at_idx" ON "exercise_templates"("trainer_id", "deleted_at");

-- CreateIndex
CREATE INDEX "exercise_templates_is_public_deleted_at_idx" ON "exercise_templates"("is_public", "deleted_at");

-- CreateIndex
CREATE INDEX "training_protocol_templates_trainer_id_deleted_at_idx" ON "training_protocol_templates"("trainer_id", "deleted_at");

-- CreateIndex
CREATE INDEX "training_templates_trainer_id_deleted_at_idx" ON "training_templates"("trainer_id", "deleted_at");

-- CreateIndex
CREATE INDEX "training_templates_is_public_deleted_at_idx" ON "training_templates"("is_public", "deleted_at");

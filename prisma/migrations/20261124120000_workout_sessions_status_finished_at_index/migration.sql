-- CreateIndex
CREATE INDEX "workout_sessions_status_finished_at_idx" ON "workout_sessions"("status", "finished_at");

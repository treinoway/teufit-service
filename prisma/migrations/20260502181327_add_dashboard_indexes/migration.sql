-- AddIndex: WorkoutSession (userId, status, startedAt DESC) for dashboard summary queries
CREATE INDEX "workout_sessions_user_id_status_started_at_idx" ON "workout_sessions"("user_id", "status", "started_at" DESC);

-- AddIndex: WorkoutSession (userId, startedAt DESC) for recent sessions queries
CREATE INDEX "workout_sessions_user_id_started_at_idx" ON "workout_sessions"("user_id", "started_at" DESC);

-- AddIndex: ExerciseLog (workoutSessionId, exerciseId) for progression aggregations
CREATE INDEX "exercise_logs_workout_session_id_exercise_id_idx" ON "exercise_logs"("workout_session_id", "exercise_id");

-- AddIndex: SetLog (exerciseLogId, completed) for filtering completed sets in aggregations
CREATE INDEX "set_logs_exercise_log_id_completed_idx" ON "set_logs"("exercise_log_id", "completed");

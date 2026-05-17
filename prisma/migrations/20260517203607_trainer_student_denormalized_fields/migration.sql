-- AlterTable
ALTER TABLE "trainer_students" ADD COLUMN     "current_pr_at" TIMESTAMPTZ(6),
ADD COLUMN     "current_pr_load" DOUBLE PRECISION,
ADD COLUMN     "last_workout_at" TIMESTAMPTZ(6);

-- Backfill last_workout_at: most recent completed WorkoutSession.finishedAt
-- per (trainer, student) pair.
WITH last_completed AS (
  SELECT user_id, MAX(finished_at) AS last_finished
  FROM workout_sessions
  WHERE status = 'completed' AND deleted_at IS NULL AND finished_at IS NOT NULL
  GROUP BY user_id
)
UPDATE trainer_students ts
SET last_workout_at = lc.last_finished
FROM last_completed lc
WHERE ts.student_id = lc.user_id;

-- Backfill current_pr_load / current_pr_at: max load across all completed
-- SetLogs per student. PR timestamp is the most recent set log that hit that
-- max load (ties broken by latest createdAt).
WITH pr_per_student AS (
  SELECT
    ws.user_id,
    MAX(sl.load) AS max_load
  FROM set_logs sl
  JOIN exercise_logs el ON el.id = sl.exercise_log_id
  JOIN workout_sessions ws ON ws.id = el.workout_session_id
  WHERE sl.load IS NOT NULL
    AND sl.completed = true
    AND ws.deleted_at IS NULL
  GROUP BY ws.user_id
),
pr_with_at AS (
  SELECT
    ws.user_id,
    pr.max_load,
    MAX(sl.created_at) AS pr_at
  FROM pr_per_student pr
  JOIN workout_sessions ws ON ws.user_id = pr.user_id
  JOIN exercise_logs el ON el.workout_session_id = ws.id
  JOIN set_logs sl ON sl.exercise_log_id = el.id
  WHERE sl.load = pr.max_load
    AND sl.completed = true
    AND ws.deleted_at IS NULL
  GROUP BY ws.user_id, pr.max_load
)
UPDATE trainer_students ts
SET current_pr_load = p.max_load,
    current_pr_at = p.pr_at
FROM pr_with_at p
WHERE ts.student_id = p.user_id;

-- Refactor: Everything is a challenge
-- Staging-only migration: no production data to preserve.

-- Step 1: Drop existing point_transactions rows (staging only — no data to preserve)
DELETE FROM point_transactions;

-- Step 2: Drop point_balances rows (will be recomputed from transactions)
DELETE FROM point_balances;

-- Step 3: Drop old indexes on point_transactions
DROP INDEX IF EXISTS "point_transactions_student_id_trainer_id_idx";
DROP INDEX IF EXISTS "point_transactions_trainer_id_created_at_idx";
DROP INDEX IF EXISTS "point_transactions_student_id_created_at_idx";

-- Step 4: Drop old unique index on point_transactions (was created as INDEX, not CONSTRAINT)
DROP INDEX IF EXISTS "point_transactions_action_reference_id_key";

-- Step 5: Add per-challenge gamification config fields to challenges
ALTER TABLE "challenges"
  ADD COLUMN "pts_workout_completed" INTEGER,
  ADD COLUMN "pts_streak_7_days" INTEGER,
  ADD COLUMN "pts_streak_30_days" INTEGER,
  ADD COLUMN "pts_daily_checkin" INTEGER,
  ADD COLUMN "pts_evolution_record" INTEGER,
  ADD COLUMN "pts_workout_feedback" INTEGER,
  ADD COLUMN "daily_points_cap" INTEGER;

-- Step 6: Add challengeId (required) to point_transactions
ALTER TABLE "point_transactions"
  ADD COLUMN "challenge_id" UUID NOT NULL;

-- Step 7: Add FK constraint for challenge_id
ALTER TABLE "point_transactions"
  ADD CONSTRAINT "point_transactions_challenge_id_fkey"
  FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE CASCADE;

-- Step 8: Add new unique constraint including challengeId
ALTER TABLE "point_transactions"
  ADD CONSTRAINT "point_transactions_action_reference_id_challenge_id_key"
  UNIQUE ("action", "reference_id", "challenge_id");

-- Step 9: Add new indexes on point_transactions
CREATE INDEX "point_transactions_challenge_id_student_id_idx"
  ON "point_transactions"("challenge_id", "student_id");

CREATE INDEX "point_transactions_challenge_id_created_at_idx"
  ON "point_transactions"("challenge_id", "created_at");

CREATE INDEX "point_transactions_student_id_trainer_id_idx"
  ON "point_transactions"("student_id", "trainer_id");

-- Step 10: Drop ranking_mode column from gamification_configs
ALTER TABLE "gamification_configs" DROP COLUMN "ranking_mode";

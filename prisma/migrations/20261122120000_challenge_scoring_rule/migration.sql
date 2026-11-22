-- AlterTable
ALTER TABLE "challenges" ADD COLUMN     "active_pillars" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "weights" JSONB;

-- Backfill (CPD-18): each weekly championship gets the weights and active pillars of the
-- trainer rule in force on its start Monday (latest effective_from <= start_date), or the
-- F1 defaults (DEFAULT_CONFIG in src/constants/consistency-ranking.js) when no rule exists.
UPDATE "challenges" AS c
SET
  "weights" = COALESCE(
    (SELECT r."weights" FROM "consistency_scoring_rules" AS r
      WHERE r."trainer_id" = c."trainer_id" AND r."effective_from" <= c."start_date"
      ORDER BY r."effective_from" DESC LIMIT 1),
    '{"workouts": 30, "diet": 30, "cardio": 15, "feedback": 15, "hydration": 10}'::jsonb
  ),
  "active_pillars" = COALESCE(
    (SELECT r."active_pillars" FROM "consistency_scoring_rules" AS r
      WHERE r."trainer_id" = c."trainer_id" AND r."effective_from" <= c."start_date"
      ORDER BY r."effective_from" DESC LIMIT 1),
    ARRAY['workouts', 'cardio', 'feedback', 'hydration']::TEXT[]
  )
WHERE c."format" = 'weeks' AND c."weights" IS NULL;

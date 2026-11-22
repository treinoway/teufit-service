-- Open signup: every trainer is BETA. Grants BETA to trainers with no subscription row or on FREE without Asaas.
-- Idempotent: a second run finds no such trainer. Paid, past-due, admin-granted and Asaas-linked rows are untouched.
-- Soft-deleted trainers and users are ignored: no BETA row and no reactivated student link for a deleted account.
CREATE TEMP TABLE beta_all_backfill_trainers AS
SELECT t.id AS trainer_id
FROM trainers t
JOIN users u ON u.id = t.user_id
LEFT JOIN platform_subscriptions s ON s.trainer_id = t.id
WHERE t.deleted_at IS NULL
  AND u.deleted_at IS NULL
  AND (s.id IS NULL OR (s.tier = 'FREE' AND s.asaas_subscription_id IS NULL));

INSERT INTO platform_subscriptions (id, trainer_id, tier, status, created_at, updated_at)
SELECT gen_random_uuid(), b.trainer_id, 'BETA', 'ACTIVE', NOW(), NOW()
FROM beta_all_backfill_trainers b
WHERE NOT EXISTS (SELECT 1 FROM platform_subscriptions s WHERE s.trainer_id = b.trainer_id);

UPDATE platform_subscriptions s
SET tier = 'BETA', status = 'ACTIVE', past_due_since = NULL, updated_at = NOW()
FROM beta_all_backfill_trainers b
WHERE s.trainer_id = b.trainer_id
  AND s.tier = 'FREE'
  AND s.asaas_subscription_id IS NULL;

UPDATE trainer_students ts
SET active_on_plan = TRUE
FROM beta_all_backfill_trainers b
WHERE ts.trainer_id = b.trainer_id
  AND ts.active_on_plan = FALSE;

DROP TABLE beta_all_backfill_trainers;

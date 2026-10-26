-- Grants BETA to live trainers who joined through an accepted invite, unless they already pay via Asaas.
CREATE TEMP TABLE beta_backfill_trainers AS
SELECT DISTINCT t.id AS trainer_id
FROM trainers t
JOIN users u ON u.id = t.user_id AND u.deleted_at IS NULL
JOIN trainer_invites i ON i.user_id = t.user_id AND i.status = 'accepted'
LEFT JOIN platform_subscriptions s ON s.trainer_id = t.id
WHERE t.deleted_at IS NULL
  AND (s.id IS NULL OR (s.tier = 'FREE' AND s.asaas_subscription_id IS NULL));

INSERT INTO platform_subscriptions (id, trainer_id, tier, status, created_at, updated_at)
SELECT gen_random_uuid(), b.trainer_id, 'BETA', 'ACTIVE', NOW(), NOW()
FROM beta_backfill_trainers b
WHERE NOT EXISTS (SELECT 1 FROM platform_subscriptions s WHERE s.trainer_id = b.trainer_id);

UPDATE platform_subscriptions s
SET tier = 'BETA', status = 'ACTIVE', past_due_since = NULL, updated_at = NOW()
FROM beta_backfill_trainers b
WHERE s.trainer_id = b.trainer_id
  AND s.tier = 'FREE'
  AND s.asaas_subscription_id IS NULL;

UPDATE trainer_students ts
SET active_on_plan = TRUE
FROM beta_backfill_trainers b
WHERE ts.trainer_id = b.trainer_id
  AND ts.active_on_plan = FALSE;

DROP TABLE beta_backfill_trainers;

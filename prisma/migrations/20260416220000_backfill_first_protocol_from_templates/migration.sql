-- Backfill firstProtocolCreatedAt for trainers who created protocol templates
-- before the milestone hook was extended to cover template creation.
-- Only updates trainers whose firstProtocolCreatedAt is still NULL and who have
-- at least one non-deleted TrainingProtocolTemplate.
UPDATE trainers t
SET first_protocol_created_at = sub.min_created_at
FROM (
  SELECT trainer_id, MIN(created_at) AS min_created_at
  FROM training_protocol_templates
  WHERE deleted_at IS NULL
  GROUP BY trainer_id
) sub
WHERE t.id = sub.trainer_id
  AND t.first_protocol_created_at IS NULL;

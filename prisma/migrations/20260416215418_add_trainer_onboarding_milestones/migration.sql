-- AlterTable
ALTER TABLE "trainers" ADD COLUMN     "first_protocol_created_at" TIMESTAMPTZ(6),
ADD COLUMN     "first_student_linked_at" TIMESTAMPTZ(6),
ADD COLUMN     "profile_completed_at" TIMESTAMPTZ(6);

-- Backfill: mark profileCompletedAt for trainers whose User + Address already has all required fields
UPDATE trainers t
SET profile_completed_at = NOW()
WHERE profile_completed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = t.user_id
      AND u.first_name IS NOT NULL AND u.first_name <> ''
      AND u.last_name IS NOT NULL AND u.last_name <> ''
      AND u.birth_date IS NOT NULL
      AND u.gender IS NOT NULL AND u.gender <> ''
      AND EXISTS (
        SELECT 1 FROM addresses a
        WHERE a.user_id = u.id
          AND a.line1 IS NOT NULL AND a.line1 <> ''
          AND a.city IS NOT NULL AND a.city <> ''
          AND a.state IS NOT NULL AND a.state <> ''
          AND a.postal_code IS NOT NULL AND a.postal_code <> ''
          AND a.country IS NOT NULL AND a.country <> ''
      )
  );

-- Backfill: mark firstStudentLinkedAt using the earliest TrainerStudent created_at
UPDATE trainers t
SET first_student_linked_at = (
  SELECT MIN(ts.created_at)
  FROM trainer_students ts
  WHERE ts.trainer_id = t.id
)
WHERE first_student_linked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM trainer_students ts WHERE ts.trainer_id = t.id
  );

-- Backfill: mark firstProtocolCreatedAt using the earliest TrainingProtocol created_at
UPDATE trainers t
SET first_protocol_created_at = (
  SELECT MIN(tp.created_at)
  FROM training_protocols tp
  WHERE tp.trainer_id = t.id
)
WHERE first_protocol_created_at IS NULL
  AND EXISTS (
    SELECT 1 FROM training_protocols tp WHERE tp.trainer_id = t.id
  );

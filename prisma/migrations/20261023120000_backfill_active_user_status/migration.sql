-- Backfill: users already linked to a trainer as student, or with a verified
-- account, are active (email proven / trainer link). Idempotent.
UPDATE "users"
SET "status" = 'active'
WHERE "status" = 'pending'
  AND "deleted_at" IS NULL
  AND (
    "id" IN (SELECT "student_id" FROM "trainer_students")
    OR "id" IN (SELECT "user_id" FROM "accounts" WHERE "verified_at" IS NOT NULL)
  );

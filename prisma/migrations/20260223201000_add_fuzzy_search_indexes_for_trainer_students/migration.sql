CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Speed up filtering linked students by trainer.
CREATE INDEX IF NOT EXISTS "trainer_students_trainer_id_idx"
  ON "trainer_students" ("trainer_id");

-- Speed up fuzzy and partial search by email for active users.
CREATE INDEX IF NOT EXISTS "users_email_trgm_idx"
  ON "users"
  USING gin (lower(COALESCE("email", '')) gin_trgm_ops)
  WHERE "deleted_at" IS NULL;

-- Speed up fuzzy and partial search by full name for active users.
CREATE INDEX IF NOT EXISTS "users_full_name_trgm_idx"
  ON "users"
  USING gin (
    lower((COALESCE("first_name", '') || ' ' || COALESCE("last_name", ''))) gin_trgm_ops
  )
  WHERE "deleted_at" IS NULL;

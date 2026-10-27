-- Trainer onboarding beta: new milestones, example-routine flags and backfills.
ALTER TABLE "trainers" ADD COLUMN "first_student_invited_at" TIMESTAMPTZ(6);
ALTER TABLE "trainers" ADD COLUMN "first_anamnesis_sent_at" TIMESTAMPTZ(6);
ALTER TABLE "trainers" ADD COLUMN "branding_configured_at" TIMESTAMPTZ(6);

ALTER TABLE "training_protocol_templates" ADD COLUMN "is_example" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "training_templates" ADD COLUMN "is_example" BOOLEAN NOT NULL DEFAULT false;

UPDATE "trainers" t
SET "first_student_invited_at" = i.first_at
FROM (
  SELECT "trainer_id", MIN("created_at") AS first_at FROM "student_invites" GROUP BY "trainer_id"
) i
WHERE t."id" = i."trainer_id";

UPDATE "trainers" t
SET "first_anamnesis_sent_at" = a.first_at
FROM (
  SELECT "trainer_id", MIN("created_at") AS first_at FROM "student_anamneses" GROUP BY "trainer_id"
) a
WHERE t."id" = a."trainer_id";

UPDATE "trainers" t
SET "branding_configured_at" = b."created_at"
FROM "trainer_brandings" b
WHERE t."id" = b."trainer_id";

UPDATE "trainers" t
SET "profile_completed_at" = now()
FROM "users" u
WHERE t."user_id" = u."id"
  AND t."profile_completed_at" IS NULL
  AND btrim(coalesce(u."first_name", '')) <> ''
  AND btrim(coalesce(u."last_name", '')) <> ''
  AND btrim(coalesce(u."avatar_url", '')) <> '';

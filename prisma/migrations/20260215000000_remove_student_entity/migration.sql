-- gen_random_uuid() is built-in since PostgreSQL 13; enable pgcrypto for older versions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create user_health_details table (1:1 with User)
CREATE TABLE "user_health_details" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "weight" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "body_fat" DOUBLE PRECISION,
    "conditions" TEXT,

    CONSTRAINT "user_health_details_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_health_details_user_id_key" ON "user_health_details"("user_id");

-- Migrate data: one record per user (most recent by created_at)
INSERT INTO "user_health_details" ("id", "user_id", "created_at", "updated_at", "deleted_at", "weight", "height", "body_fat", "conditions")
SELECT DISTINCT ON (s."user_id")
    gen_random_uuid(),
    s."user_id",
    sh."created_at",
    sh."updated_at",
    sh."deleted_at",
    sh."weight",
    sh."height",
    sh."body_fat",
    sh."conditions"
FROM "student_health_details" sh
JOIN "students" s ON sh."student_id" = s."id"
ORDER BY s."user_id", sh."created_at" DESC;

-- Drop student_health_details
DROP TABLE "student_health_details";

-- Add assignee_id to training_protocols
ALTER TABLE "training_protocols" ADD COLUMN "assignee_id" UUID;

-- Migrate: set assignee_id from students.user_id
UPDATE "training_protocols" tp
SET "assignee_id" = s."user_id"
FROM "students" s
WHERE tp."student_id" = s."id";

-- Drop student_id FK and column
ALTER TABLE "training_protocols" DROP CONSTRAINT IF EXISTS "training_protocols_student_id_fkey";
ALTER TABLE "training_protocols" DROP COLUMN "student_id";

-- Add FK for assignee_id
ALTER TABLE "training_protocols" ADD CONSTRAINT "training_protocols_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Make assignee_id NOT NULL (after data migrated)
ALTER TABLE "training_protocols" ALTER COLUMN "assignee_id" SET NOT NULL;

-- Drop students table
DROP TABLE "students";

-- Clean up roles: remove 'student' from users.roles
UPDATE "users" SET "roles" = array_remove("roles", 'student') WHERE 'student' = ANY("roles");

-- Add FK for user_health_details
ALTER TABLE "user_health_details" ADD CONSTRAINT "user_health_details_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

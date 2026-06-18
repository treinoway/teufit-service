-- Pre-existing schema drift cleanup: the ai_interaction_logs.id column was created
-- with a DEFAULT that no longer matches the Prisma schema. This migration removes
-- that stale DEFAULT so the schema stays in sync with the data model.
ALTER TABLE "ai_interaction_logs" ALTER COLUMN "id" DROP DEFAULT;

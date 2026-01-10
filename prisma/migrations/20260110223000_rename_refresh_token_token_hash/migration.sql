-- Rename the refresh token column to match the Prisma model and support hashed storage.
-- Also add a revoked_at timestamp and revoke any existing tokens (forces re-login).

ALTER TABLE "refresh_tokens" RENAME COLUMN "token" TO "token_hash";

ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6);

-- Existing tokens (if any) were previously stored under the old column name.
-- Revoke them to avoid ambiguity and enforce the new issuance flow.
UPDATE "refresh_tokens"
SET "revoked" = true,
    "revoked_at" = COALESCE("revoked_at", NOW());

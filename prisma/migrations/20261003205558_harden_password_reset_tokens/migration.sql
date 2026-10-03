-- DropIndex
DROP INDEX "password_reset_tokens_token_hash_key";

-- AlterTable
ALTER TABLE "password_reset_tokens" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

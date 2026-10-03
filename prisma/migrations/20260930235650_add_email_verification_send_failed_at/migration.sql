-- AlterTable
ALTER TABLE "email_verification_tokens" ADD COLUMN     "send_failed_at" TIMESTAMPTZ(6);

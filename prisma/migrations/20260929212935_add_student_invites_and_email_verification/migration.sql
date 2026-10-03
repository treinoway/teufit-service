-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "verified_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_invites" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "student_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_used_idx" ON "email_verification_tokens"("user_id", "used");

-- CreateIndex
CREATE INDEX "student_invites_trainer_id_status_created_at_idx" ON "student_invites"("trainer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "student_invites_email_status_idx" ON "student_invites"("email", "status");

-- CreateIndex
CREATE INDEX "student_invites_student_id_idx" ON "student_invites"("student_id");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_invites" ADD CONSTRAINT "student_invites_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_invites" ADD CONSTRAINT "student_invites_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: one open (pending) invite per trainer + email. Prisma cannot
-- express partial unique indexes. Makes concurrent duplicate invites race-safe.
CREATE UNIQUE INDEX "student_invites_trainer_id_email_pending_key"
  ON "student_invites"("trainer_id", "email")
  WHERE "status" = 'pending';

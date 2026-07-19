-- CreateTable
CREATE TABLE "trainer_invites" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invited_by_user_id" UUID NOT NULL,
    "user_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "trainer_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trainer_invites_code_hash_key" ON "trainer_invites"("code_hash");

-- CreateIndex
CREATE INDEX "trainer_invites_email_idx" ON "trainer_invites"("email");

-- CreateIndex
CREATE INDEX "trainer_invites_invited_by_user_id_idx" ON "trainer_invites"("invited_by_user_id");

-- CreateIndex
CREATE INDEX "trainer_invites_user_id_idx" ON "trainer_invites"("user_id");

-- AddForeignKey
ALTER TABLE "trainer_invites" ADD CONSTRAINT "trainer_invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainer_invites" ADD CONSTRAINT "trainer_invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

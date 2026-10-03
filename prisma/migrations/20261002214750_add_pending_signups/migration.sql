-- CreateTable
CREATE TABLE "pending_signups" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pending_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_signup_codes" (
    "id" UUID NOT NULL,
    "pending_signup_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "send_failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "pending_signup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "existing_account_notices" (
    "email" TEXT NOT NULL,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "existing_account_notices_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_signups_email_key" ON "pending_signups"("email");

-- CreateIndex
CREATE INDEX "pending_signups_updated_at_idx" ON "pending_signups"("updated_at");

-- CreateIndex
CREATE INDEX "pending_signup_codes_pending_signup_id_used_idx" ON "pending_signup_codes"("pending_signup_id", "used");

-- AddForeignKey
ALTER TABLE "pending_signup_codes" ADD CONSTRAINT "pending_signup_codes_pending_signup_id_fkey" FOREIGN KEY ("pending_signup_id") REFERENCES "pending_signups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

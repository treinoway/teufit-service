-- CreateEnum
CREATE TYPE "PlatformPlanTier" AS ENUM ('FREE', 'PRO', 'PLATINUM', 'DIAMOND');

-- CreateEnum
CREATE TYPE "PlatformSubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "PlatformBillingType" AS ENUM ('PIX', 'CREDIT_CARD', 'BOLETO');

-- CreateEnum
CREATE TYPE "PlatformPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'OVERDUE', 'REFUNDED', 'FAILED');

-- AlterTable
ALTER TABLE "trainer_students" ADD COLUMN     "active_on_plan" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "platform_subscriptions" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "tier" "PlatformPlanTier" NOT NULL DEFAULT 'FREE',
    "status" "PlatformSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "asaas_customer_id" TEXT,
    "asaas_subscription_id" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMP(3),
    "past_due_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_subscription_payments" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "asaas_payment_id" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "billing_type" "PlatformBillingType" NOT NULL,
    "status" "PlatformPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "due_date" DATE NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID,
    "action" TEXT NOT NULL,
    "billing_month" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_subscriptions_trainer_id_key" ON "platform_subscriptions"("trainer_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_subscriptions_asaas_subscription_id_key" ON "platform_subscriptions"("asaas_subscription_id");

-- CreateIndex
CREATE INDEX "platform_subscriptions_tier_status_idx" ON "platform_subscriptions"("tier", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_subscription_payments_asaas_payment_id_key" ON "platform_subscription_payments"("asaas_payment_id");

-- CreateIndex
CREATE INDEX "platform_subscription_payments_subscription_id_status_idx" ON "platform_subscription_payments"("subscription_id", "status");

-- CreateIndex
CREATE INDEX "platform_subscription_payments_due_date_idx" ON "platform_subscription_payments"("due_date");

-- CreateIndex
CREATE INDEX "ai_usage_events_trainer_id_billing_month_idx" ON "ai_usage_events"("trainer_id", "billing_month");

-- CreateIndex
CREATE INDEX "ai_usage_events_trainer_id_student_id_billing_month_idx" ON "ai_usage_events"("trainer_id", "student_id", "billing_month");

-- CreateIndex
CREATE INDEX "trainer_students_trainer_id_active_on_plan_idx" ON "trainer_students"("trainer_id", "active_on_plan");

-- AddForeignKey
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_subscription_payments" ADD CONSTRAINT "platform_subscription_payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "platform_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every existing (non-deleted) trainer gets a FREE ACTIVE platform subscription
INSERT INTO platform_subscriptions (id, trainer_id, tier, status, created_at, updated_at)
SELECT gen_random_uuid(), id, 'FREE', 'ACTIVE', NOW(), NOW()
FROM trainers
WHERE deleted_at IS NULL;

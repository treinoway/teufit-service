-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN "billing_day" INTEGER;
ALTER TABLE "student_subscriptions" ADD COLUMN "billing_day" INTEGER;

-- Billing day is a day of the month (29-31 clamp to the month length at runtime)
ALTER TABLE "subscription_plans"
  ADD CONSTRAINT "subscription_plans_billing_day_range" CHECK ("billing_day" BETWEEN 1 AND 31);
ALTER TABLE "student_subscriptions"
  ADD CONSTRAINT "student_subscriptions_billing_day_range" CHECK ("billing_day" BETWEEN 1 AND 31);

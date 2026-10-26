-- Marks subscriptions whose Asaas checkout was started but not yet paid (cleared by the payment webhook).
ALTER TABLE "platform_subscriptions" ADD COLUMN "checkout_pending_since" TIMESTAMP(3);

-- Existing linked subscriptions with no confirmed payment are unpaid checkouts.
UPDATE "platform_subscriptions" s
SET "checkout_pending_since" = s."updated_at"
WHERE s."asaas_subscription_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "platform_subscription_payments" p
    WHERE p."subscription_id" = s."id" AND p."status" = 'CONFIRMED'
  );

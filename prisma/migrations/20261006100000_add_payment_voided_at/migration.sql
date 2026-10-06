-- Remember that a charge was voided, even if it is later paid (late settlement)
-- and reverted: reverting a voided-then-paid charge must go back to 'cancelled'.
ALTER TABLE "subscription_payments" ADD COLUMN "voided_at" TIMESTAMPTZ(6);

-- Backfill: already-cancelled payments were voided at some point.
UPDATE "subscription_payments"
SET "voided_at" = COALESCE("updated_at", "created_at")
WHERE "status" = 'cancelled';

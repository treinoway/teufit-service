-- Financeiro: idempotency key for subscription cycle generation.
--
-- Pre-existing payments with the same cycle position cannot exist yet (the
-- column is new): positions are backfilled with ROW_NUMBER per subscription
-- ordered chronologically, so the unique constraint always holds and no
-- payment is deleted. Cycles that were created manually with overlapping or
-- duplicated dates keep their rows; only their numbering is assigned here.
--
-- DEPLOY NOTE: cycle_index is NOT NULL without a default. Application
-- instances running the previous code insert payments without it and would
-- fail — deploy this migration together with the new code, without a rolling
-- overlap of old and new instances.

ALTER TABLE "subscription_payments" ADD COLUMN "cycle_index" INTEGER;

UPDATE "subscription_payments" p
SET "cycle_index" = numbered.position
FROM (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY subscription_id
           ORDER BY cycle_start_date ASC, created_at ASC, id ASC
         ) - 1 AS position
  FROM "subscription_payments"
) numbered
WHERE p.id = numbered.id;

ALTER TABLE "subscription_payments" ALTER COLUMN "cycle_index" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_subscription_id_cycle_index_key"
  ON "subscription_payments"("subscription_id", "cycle_index");

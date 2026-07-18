-- CreateIndex
CREATE INDEX "subscription_payments_subscription_id_status_paid_at_idx" ON "subscription_payments"("subscription_id", "status", "paid_at");

-- CreateIndex
CREATE INDEX "subscription_payments_subscription_id_cycle_end_date_idx" ON "subscription_payments"("subscription_id", "cycle_end_date");

-- CreateIndex
CREATE INDEX "training_protocols_trainer_id_status_expiration_date_idx" ON "training_protocols"("trainer_id", "status", "expiration_date");

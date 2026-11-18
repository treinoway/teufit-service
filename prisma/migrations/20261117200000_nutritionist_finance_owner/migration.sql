-- Student billing generalised to a "professional" owner: a plan / subscription
-- belongs to exactly ONE of a trainer or a nutritionist, and carries a
-- service_type tag (training | nutrition | both). Existing rows are trainer
-- rows and are backfilled to 'training'.

ALTER TABLE "subscription_plans" ALTER COLUMN "trainer_id" DROP NOT NULL;
ALTER TABLE "student_subscriptions" ALTER COLUMN "trainer_id" DROP NOT NULL;

ALTER TABLE "subscription_plans"
  ADD COLUMN "nutritionist_id" UUID,
  ADD COLUMN "service_type" TEXT NOT NULL DEFAULT 'training';

ALTER TABLE "student_subscriptions"
  ADD COLUMN "nutritionist_id" UUID,
  ADD COLUMN "service_type" TEXT NOT NULL DEFAULT 'training';

-- ON DELETE RESTRICT: billing history is accounting data. SET NULL would also
-- violate the one-owner CHECK below, and CASCADE would silently drop charges.
ALTER TABLE "subscription_plans"
  ADD CONSTRAINT "subscription_plans_nutritionist_id_fkey"
  FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_subscriptions"
  ADD CONSTRAINT "student_subscriptions_nutritionist_id_fkey"
  FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one owner per row (Prisma cannot express CHECK constraints).
ALTER TABLE "subscription_plans"
  ADD CONSTRAINT "subscription_plans_exactly_one_owner"
  CHECK (num_nonnulls("trainer_id", "nutritionist_id") = 1);

ALTER TABLE "student_subscriptions"
  ADD CONSTRAINT "student_subscriptions_exactly_one_owner"
  CHECK (num_nonnulls("trainer_id", "nutritionist_id") = 1);

-- One active subscription per (nutritionist, student) pair: DB backstop of the
-- assign lock, twin of student_subscriptions_one_active_per_pair for trainers.
CREATE UNIQUE INDEX "student_subscriptions_one_active_per_nutritionist_pair"
  ON "student_subscriptions" ("nutritionist_id", "student_id")
  WHERE "status" = 'active' AND "nutritionist_id" IS NOT NULL;

CREATE INDEX "subscription_plans_nutritionist_id_deleted_at_idx"
  ON "subscription_plans" ("nutritionist_id", "deleted_at");

CREATE INDEX "student_subscriptions_nutritionist_id_status_idx"
  ON "student_subscriptions" ("nutritionist_id", "status");

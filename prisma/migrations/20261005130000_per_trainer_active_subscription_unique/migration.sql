-- A student may be linked to several trainers: allow ONE active subscription
-- per (trainer, student) pair instead of one per student globally.
-- (Creating the new index cannot fail on existing data: it is strictly weaker
-- than the one it replaces.)
DROP INDEX IF EXISTS "student_subscriptions_one_active_per_student";

CREATE UNIQUE INDEX "student_subscriptions_one_active_per_pair"
  ON "student_subscriptions" ("trainer_id", "student_id")
  WHERE "status" = 'active';

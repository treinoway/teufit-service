-- CreateTable
CREATE TABLE "gamification_configs" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pts_workout_completed" INTEGER,
    "pts_streak_7_days" INTEGER,
    "pts_streak_30_days" INTEGER,
    "pts_daily_checkin" INTEGER,
    "pts_evolution_record" INTEGER,
    "pts_workout_feedback" INTEGER,
    "daily_points_cap" INTEGER,
    "streak_tolerance_hours" INTEGER NOT NULL DEFAULT 24,
    "ranking_mode" TEXT NOT NULL DEFAULT 'weekly',
    "anonymous_ranking" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "gamification_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_transactions" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reference_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_balances" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "point_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenges" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    "participant_mode" TEXT NOT NULL,
    "filter_criteria" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_participants" (
    "id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenge_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gamification_configs_trainer_id_key" ON "gamification_configs"("trainer_id");

-- CreateIndex
CREATE INDEX "point_transactions_student_id_trainer_id_idx" ON "point_transactions"("student_id", "trainer_id");

-- CreateIndex
CREATE INDEX "point_transactions_trainer_id_created_at_idx" ON "point_transactions"("trainer_id", "created_at");

-- CreateIndex
CREATE INDEX "point_transactions_student_id_created_at_idx" ON "point_transactions"("student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "point_transactions_action_reference_id_key" ON "point_transactions"("action", "reference_id");

-- CreateIndex
CREATE INDEX "point_balances_trainer_id_total_points_idx" ON "point_balances"("trainer_id", "total_points");

-- CreateIndex
CREATE UNIQUE INDEX "point_balances_student_id_trainer_id_key" ON "point_balances"("student_id", "trainer_id");

-- CreateIndex
CREATE INDEX "challenges_trainer_id_start_date_idx" ON "challenges"("trainer_id", "start_date");

-- CreateIndex
CREATE INDEX "challenges_trainer_id_end_date_idx" ON "challenges"("trainer_id", "end_date");

-- CreateIndex
CREATE INDEX "challenge_participants_student_id_idx" ON "challenge_participants"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_participants_challenge_id_student_id_key" ON "challenge_participants"("challenge_id", "student_id");

-- AddForeignKey
ALTER TABLE "gamification_configs" ADD CONSTRAINT "gamification_configs_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_balances" ADD CONSTRAINT "point_balances_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_balances" ADD CONSTRAINT "point_balances_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

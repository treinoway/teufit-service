-- CreateTable
CREATE TABLE "consistency_ranking_configs" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "min_podium_weeks" INTEGER NOT NULL DEFAULT 2,
    "season_weeks" INTEGER NOT NULL DEFAULT 4,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "consistency_ranking_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_scoring_rules" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "weights" JSONB NOT NULL,
    "active_pillars" TEXT[],
    "close_weekday" INTEGER NOT NULL,
    "close_hour" INTEGER NOT NULL,
    "time_zone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consistency_scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_seasons" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "start_week" DATE NOT NULL,
    "weeks" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "close_requested_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "consistency_seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_weekly_targets" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "pillar" TEXT NOT NULL,
    "expected" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consistency_weekly_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_weekly_results" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "score" DECIMAL(7,4),
    "pillars" JSONB NOT NULL,
    "weights" JSONB NOT NULL,
    "closed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consistency_weekly_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_week_closes" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "closed_at" TIMESTAMPTZ(6) NOT NULL,
    "students_count" INTEGER NOT NULL,

    CONSTRAINT "consistency_week_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_season_standings" (
    "id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "position" INTEGER,
    "eligible" BOOLEAN NOT NULL,
    "average" DECIMAL(7,4),
    "valid_weeks" INTEGER NOT NULL,
    "weeks_100" INTEGER NOT NULL,
    "streak" INTEGER NOT NULL,
    "frozen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consistency_season_standings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consistency_week_pauses" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "student_id" UUID,
    "week_start" DATE NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consistency_week_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consistency_ranking_configs_trainer_id_key" ON "consistency_ranking_configs"("trainer_id");

-- CreateIndex
CREATE UNIQUE INDEX "consistency_scoring_rules_trainer_id_effective_from_key" ON "consistency_scoring_rules"("trainer_id", "effective_from");

-- CreateIndex
CREATE INDEX "consistency_seasons_trainer_id_status_idx" ON "consistency_seasons"("trainer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consistency_seasons_trainer_id_number_key" ON "consistency_seasons"("trainer_id", "number");

-- CreateIndex
CREATE INDEX "consistency_weekly_targets_trainer_id_week_start_idx" ON "consistency_weekly_targets"("trainer_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "consistency_weekly_targets_trainer_id_student_id_week_start_key" ON "consistency_weekly_targets"("trainer_id", "student_id", "week_start", "pillar");

-- CreateIndex
CREATE INDEX "consistency_weekly_results_trainer_id_season_id_idx" ON "consistency_weekly_results"("trainer_id", "season_id");

-- CreateIndex
CREATE INDEX "consistency_weekly_results_trainer_id_student_id_week_start_idx" ON "consistency_weekly_results"("trainer_id", "student_id", "week_start" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "consistency_weekly_results_trainer_id_student_id_week_start_key" ON "consistency_weekly_results"("trainer_id", "student_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "consistency_week_closes_trainer_id_week_start_key" ON "consistency_week_closes"("trainer_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "consistency_season_standings_season_id_student_id_key" ON "consistency_season_standings"("season_id", "student_id");

-- CreateIndex
CREATE INDEX "consistency_week_pauses_trainer_id_week_start_idx" ON "consistency_week_pauses"("trainer_id", "week_start");

-- CreateIndex
CREATE INDEX "workout_sessions_user_id_status_finished_at_idx" ON "workout_sessions"("user_id", "status", "finished_at");

-- AddForeignKey
ALTER TABLE "consistency_ranking_configs" ADD CONSTRAINT "consistency_ranking_configs_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_scoring_rules" ADD CONSTRAINT "consistency_scoring_rules_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_seasons" ADD CONSTRAINT "consistency_seasons_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_weekly_targets" ADD CONSTRAINT "consistency_weekly_targets_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_weekly_targets" ADD CONSTRAINT "consistency_weekly_targets_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_weekly_results" ADD CONSTRAINT "consistency_weekly_results_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_weekly_results" ADD CONSTRAINT "consistency_weekly_results_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_weekly_results" ADD CONSTRAINT "consistency_weekly_results_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "consistency_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_week_closes" ADD CONSTRAINT "consistency_week_closes_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_season_standings" ADD CONSTRAINT "consistency_season_standings_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "consistency_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_season_standings" ADD CONSTRAINT "consistency_season_standings_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_season_standings" ADD CONSTRAINT "consistency_season_standings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_week_pauses" ADD CONSTRAINT "consistency_week_pauses_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consistency_week_pauses" ADD CONSTRAINT "consistency_week_pauses_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique indexes (Prisma cannot model them): the NULL student_id (team week) is distinct in a plain unique index.
CREATE UNIQUE INDEX "consistency_week_pauses_team_week_key" ON "consistency_week_pauses"("trainer_id", "week_start") WHERE "student_id" IS NULL;

CREATE UNIQUE INDEX "consistency_week_pauses_student_week_key" ON "consistency_week_pauses"("trainer_id", "student_id", "week_start") WHERE "student_id" IS NOT NULL;

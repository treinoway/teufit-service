-- AlterTable
ALTER TABLE "challenges" ADD COLUMN     "close_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "closed_at" TIMESTAMPTZ(6),
ADD COLUMN     "description" TEXT,
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'dates',
ADD COLUMN     "min_podium_weeks" INTEGER,
ADD COLUMN     "owner_type" TEXT NOT NULL DEFAULT 'trainer',
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'full',
ADD COLUMN     "weeks" INTEGER;

-- CreateTable
CREATE TABLE "challenge_consistency_standings" (
    "id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "position" INTEGER,
    "eligible" BOOLEAN NOT NULL,
    "average" DECIMAL(7,4),
    "valid_weeks" INTEGER NOT NULL,
    "weeks_100" INTEGER NOT NULL,
    "streak" INTEGER NOT NULL,
    "frozen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "challenge_consistency_standings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "challenge_consistency_standings_challenge_id_student_id_key" ON "challenge_consistency_standings"("challenge_id", "student_id");

-- CreateIndex
CREATE INDEX "challenges_format_closed_at_idx" ON "challenges"("format", "closed_at");

-- AddForeignKey
ALTER TABLE "challenge_consistency_standings" ADD CONSTRAINT "challenge_consistency_standings_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_consistency_standings" ADD CONSTRAINT "challenge_consistency_standings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


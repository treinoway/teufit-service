-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('BUG', 'SUGGESTION', 'PRAISE');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('NEW', 'READ');

-- CreateTable
CREATE TABLE "trainer_feedbacks" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "message" TEXT NOT NULL,
    "page_path" TEXT,
    "viewport" TEXT,
    "user_agent" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'NEW',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trainer_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trainer_feedbacks_status_created_at_idx" ON "trainer_feedbacks"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "trainer_feedbacks_trainer_id_idx" ON "trainer_feedbacks"("trainer_id");

-- AddForeignKey
ALTER TABLE "trainer_feedbacks" ADD CONSTRAINT "trainer_feedbacks_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

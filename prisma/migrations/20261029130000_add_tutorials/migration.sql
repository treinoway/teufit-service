-- CreateEnum
CREATE TYPE "TutorialVideoSource" AS ENUM ('LINK', 'UPLOAD');

-- CreateTable
CREATE TABLE "tutorials" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "video_source" "TutorialVideoSource" NOT NULL,
    "video_url" TEXT,
    "video_key" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tutorials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tutorials_order_idx" ON "tutorials"("order");

-- AddForeignKey
ALTER TABLE "tutorials" ADD CONSTRAINT "tutorials_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

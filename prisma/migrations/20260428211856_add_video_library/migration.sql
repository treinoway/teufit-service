-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "duration" INTEGER,
    "category" TEXT NOT NULL,
    "body_segment" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "videos_category_idx" ON "videos"("category");

-- CreateIndex
CREATE INDEX "videos_body_segment_idx" ON "videos"("body_segment");

-- CreateIndex
CREATE INDEX "videos_deleted_at_idx" ON "videos"("deleted_at");

-- CreateIndex
CREATE INDEX "videos_tags_idx" ON "videos" USING GIN ("tags");

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

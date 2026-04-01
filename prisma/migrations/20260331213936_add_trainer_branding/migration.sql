-- CreateTable
CREATE TABLE "trainer_brandings" (
    "id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "primary_color" TEXT NOT NULL,
    "logo_url" TEXT,
    "cover_image_url" TEXT,
    "welcome_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "trainer_brandings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trainer_brandings_trainer_id_key" ON "trainer_brandings"("trainer_id");

-- AddForeignKey
ALTER TABLE "trainer_brandings" ADD CONSTRAINT "trainer_brandings_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

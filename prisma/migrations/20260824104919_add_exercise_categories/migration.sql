-- CreateTable
CREATE TABLE "exercise_categories" (
    "id" UUID NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "trainer_id" UUID,
    "name" TEXT NOT NULL,
    "name_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "exercise_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_exercise_categories" (
    "id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "exercise_category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercise_exercise_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_template_exercise_categories" (
    "id" UUID NOT NULL,
    "exercise_template_id" UUID NOT NULL,
    "exercise_category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercise_template_exercise_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exercise_categories_trainer_id_deleted_at_idx" ON "exercise_categories"("trainer_id", "deleted_at");

-- CreateIndex
CREATE INDEX "exercise_categories_is_public_deleted_at_idx" ON "exercise_categories"("is_public", "deleted_at");

-- CreateIndex
CREATE INDEX "exercise_exercise_categories_exercise_category_id_exercise__idx" ON "exercise_exercise_categories"("exercise_category_id", "exercise_id");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_exercise_categories_exercise_id_exercise_category__key" ON "exercise_exercise_categories"("exercise_id", "exercise_category_id");

-- CreateIndex
CREATE INDEX "exercise_template_exercise_categories_exercise_category_id__idx" ON "exercise_template_exercise_categories"("exercise_category_id", "exercise_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_template_exercise_categories_exercise_template_id__key" ON "exercise_template_exercise_categories"("exercise_template_id", "exercise_category_id");

-- AddForeignKey
ALTER TABLE "exercise_categories" ADD CONSTRAINT "exercise_categories_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_exercise_categories" ADD CONSTRAINT "exercise_exercise_categories_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_exercise_categories" ADD CONSTRAINT "exercise_exercise_categories_exercise_category_id_fkey" FOREIGN KEY ("exercise_category_id") REFERENCES "exercise_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_template_exercise_categories" ADD CONSTRAINT "exercise_template_exercise_categories_exercise_template_id_fkey" FOREIGN KEY ("exercise_template_id") REFERENCES "exercise_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_template_exercise_categories" ADD CONSTRAINT "exercise_template_exercise_categories_exercise_category_id_fkey" FOREIGN KEY ("exercise_category_id") REFERENCES "exercise_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Not representable in schema.prisma — keeps is_public/trainer_id from diverging.
ALTER TABLE "exercise_categories"
  ADD CONSTRAINT "exercise_categories_public_ownership_chk"
  CHECK (
    (is_public = true  AND trainer_id IS NULL)
    OR
    (is_public = false AND trainer_id IS NOT NULL)
  );

-- Partial unique indexes, one per scope — also not representable in schema.prisma.
CREATE UNIQUE INDEX "exercise_categories_private_scope_name_uniq"
  ON "exercise_categories" ("trainer_id", "name_normalized")
  WHERE "is_public" = false AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "exercise_categories_public_name_uniq"
  ON "exercise_categories" ("name_normalized")
  WHERE "is_public" = true AND "deleted_at" IS NULL;

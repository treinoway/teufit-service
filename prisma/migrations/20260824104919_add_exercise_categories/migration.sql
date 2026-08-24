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

-- CategoryConsistencyCheck — RFC 002 addendum v3.1. NOT representable in schema.prisma.
-- Guarantees is_public and trainer_id never diverge: every public row has trainer_id
-- NULL, every private row has trainer_id set. Without this, nothing would stop an
-- inconsistent state (e.g. is_public = true with a real trainer_id) that would
-- silently break the two authorization rules built on top of these columns.
-- Guarded by test/e2e/exercise-category.e2e.test.js and ci/check-exercise-category-drift.sh —
-- if a future `prisma migrate dev` generates a DropConstraint/DropIndex touching any of
-- the three objects below, that is Prisma drift (see RFC 002 §5.6): remove the Drop
-- before applying, do not let it through review.
ALTER TABLE "exercise_categories"
  ADD CONSTRAINT "exercise_categories_public_ownership_chk"
  CHECK (
    (is_public = true  AND trainer_id IS NULL)
    OR
    (is_public = false AND trainer_id IS NOT NULL)
  );

-- ScopeUniqueness — RFC 002 addendum v3.1. Two ordinary partial unique indexes
-- (no NULLS NOT DISTINCT needed: is_public partitions the two scopes as real
-- boolean values, not via NULL semantics). WHERE deleted_at IS NULL on both keeps
-- a soft-deleted category out of the index, so recreating one with the same name
-- after deletion is a normal insert, never a P2002 collision with the old row.

-- Private scope: unique per trainer.
CREATE UNIQUE INDEX "exercise_categories_private_scope_name_uniq"
  ON "exercise_categories" ("trainer_id", "name_normalized")
  WHERE "is_public" = false AND "deleted_at" IS NULL;

-- Public scope: unique globally (no trainer_id in the key — every public row
-- shares the same scope).
CREATE UNIQUE INDEX "exercise_categories_public_name_uniq"
  ON "exercise_categories" ("name_normalized")
  WHERE "is_public" = true AND "deleted_at" IS NULL;

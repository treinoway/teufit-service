-- Nutritionist meal plan restructure. Diet data is intentionally discarded (no consumers; product decision).
-- Foods and food groups (TACO/TBCA seed) are kept.
TRUNCATE TABLE "diet_food_items", "diet_meals", "diet_protocols", "diet_template_food_items", "diet_template_meals", "diet_protocol_templates", "patient_metabolic_profiles" RESTART IDENTITY CASCADE;

-- Accent-insensitive food search.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- DropForeignKey
ALTER TABLE "diet_protocol_templates" DROP CONSTRAINT "diet_protocol_templates_nutritionist_id_fkey";

-- DropForeignKey
ALTER TABLE "diet_template_meals" DROP CONSTRAINT "diet_template_meals_diet_protocol_template_id_fkey";

-- DropForeignKey
ALTER TABLE "diet_template_food_items" DROP CONSTRAINT "diet_template_food_items_diet_template_meal_id_fkey";

-- DropForeignKey
ALTER TABLE "diet_template_food_items" DROP CONSTRAINT "diet_template_food_items_food_id_fkey";

-- DropForeignKey
ALTER TABLE "diet_protocols" DROP CONSTRAINT "diet_protocols_diet_protocol_template_id_fkey";

-- DropForeignKey
ALTER TABLE "diet_food_items" DROP CONSTRAINT "diet_food_items_diet_meal_id_fkey";

-- DropIndex
DROP INDEX "patient_metabolic_profiles_patient_id_key";

-- AlterTable
ALTER TABLE "foods" ADD COLUMN     "nutritionist_id" UUID;

-- AlterTable
ALTER TABLE "patient_metabolic_profiles" DROP COLUMN "activity_level",
DROP COLUMN "get_kcal",
DROP COLUMN "lean_body_mass_kg",
DROP COLUMN "pal_multiplier",
DROP COLUMN "tmb_formula",
DROP COLUMN "tmb_kcal",
ADD COLUMN     "assessed_at" DATE,
ADD COLUMN     "body_fat_pct" DECIMAL(5,2),
ADD COLUMN     "sex" TEXT;

-- AlterTable
ALTER TABLE "diet_protocols" DROP COLUMN "activity_level",
DROP COLUMN "daily_caloric_target",
DROP COLUMN "deleted_at",
DROP COLUMN "description",
DROP COLUMN "diet_protocol_template_id",
DROP COLUMN "diet_type",
DROP COLUMN "expiration_date",
DROP COLUMN "get_kcal",
DROP COLUMN "goal_type",
DROP COLUMN "name",
DROP COLUMN "notes",
DROP COLUMN "start_date",
DROP COLUMN "tmb_formula",
DROP COLUMN "tmb_kcal",
ADD COLUMN     "activities" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "activity_factor" DECIMAL(4,3) NOT NULL DEFAULT 1.375,
ADD COLUMN     "bmr_formula" TEXT NOT NULL DEFAULT 'mifflin',
ADD COLUMN     "carb_is_remainder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "carb_per_kg" DECIMAL(5,2),
ADD COLUMN     "fat_per_kg" DECIMAL(5,2),
ADD COLUMN     "fiber_min_g" DECIMAL(6,2),
ADD COLUMN     "first_published_at" TIMESTAMPTZ(6),
ADD COLUMN     "free_meal_text" TEXT,
ADD COLUMN     "free_meals_per_week" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "has_unpublished_changes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kcal_target" DECIMAL(8,2),
ADD COLUMN     "objective" TEXT NOT NULL DEFAULT 'maintain',
ADD COLUMN     "observations" TEXT,
ADD COLUMN     "patient_message" TEXT,
ADD COLUMN     "protein_per_kg" DECIMAL(5,2),
ADD COLUMN     "published_at" TIMESTAMPTZ(6),
ADD COLUMN     "published_snapshot" JSONB,
ADD COLUMN     "supplements" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "water_target_ml" INTEGER,
ALTER COLUMN "status" SET DEFAULT 'draft';

-- AlterTable
ALTER TABLE "diet_meals" DROP COLUMN "deleted_at",
DROP COLUMN "meal_type",
DROP COLUMN "notes",
DROP COLUMN "scheduled_time",
DROP COLUMN "template_meal_id",
ADD COLUMN     "time" VARCHAR(5) NOT NULL,
ADD COLUMN     "tip" TEXT;

-- AlterTable
ALTER TABLE "diet_food_items" DROP COLUMN "carbohydrates_g",
DROP COLUMN "deleted_at",
DROP COLUMN "diet_meal_id",
DROP COLUMN "energy_kcal",
DROP COLUMN "fiber_g",
DROP COLUMN "food_name",
DROP COLUMN "notes",
DROP COLUMN "protein_g",
DROP COLUMN "quantity_g",
DROP COLUMN "total_fat_g",
ADD COLUMN     "carbs_per_100g" DECIMAL(6,2) NOT NULL,
ADD COLUMN     "diet_meal_option_id" UUID NOT NULL,
ADD COLUMN     "fat_per_100g" DECIMAL(6,2) NOT NULL,
ADD COLUMN     "fiber_per_100g" DECIMAL(6,2) NOT NULL,
ADD COLUMN     "household_measure" VARCHAR(100),
ADD COLUMN     "kcal_per_100g" DECIMAL(8,2) NOT NULL,
ADD COLUMN     "name" VARCHAR(255) NOT NULL,
ADD COLUMN     "protein_per_100g" DECIMAL(6,2) NOT NULL,
ADD COLUMN     "quantity" DECIMAL(8,2) NOT NULL,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "swap_basis" TEXT NOT NULL DEFAULT 'protein',
ALTER COLUMN "unit" SET DATA TYPE VARCHAR(5);

-- DropTable
DROP TABLE "diet_protocol_templates";

-- DropTable
DROP TABLE "diet_template_meals";

-- DropTable
DROP TABLE "diet_template_food_items";

-- CreateTable
CREATE TABLE "diet_meal_options" (
    "id" UUID NOT NULL,
    "diet_meal_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diet_meal_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_item_substitutes" (
    "id" UUID NOT NULL,
    "diet_food_item_id" UUID NOT NULL,
    "food_id" UUID,
    "source" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "household_measure" VARCHAR(100),
    "quantity" DECIMAL(8,2) NOT NULL,
    "kcal_per_100g" DECIMAL(8,2) NOT NULL,
    "protein_per_100g" DECIMAL(6,2) NOT NULL,
    "carbs_per_100g" DECIMAL(6,2) NOT NULL,
    "fat_per_100g" DECIMAL(6,2) NOT NULL,
    "fiber_per_100g" DECIMAL(6,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diet_item_substitutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_meal_logs" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "meal_id" UUID NOT NULL,
    "option_id" UUID,
    "status" TEXT,
    "done_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_meal_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_swap_logs" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "item_id" UUID NOT NULL,
    "substitute_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diet_swap_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "water_logs" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "ml" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "water_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_invites" (
    "id" UUID NOT NULL,
    "nutritionist_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "patient_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "patient_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diet_meal_options_diet_meal_id_position_key" ON "diet_meal_options"("diet_meal_id", "position");

-- CreateIndex
CREATE INDEX "diet_item_substitutes_diet_food_item_id_idx" ON "diet_item_substitutes"("diet_food_item_id");

-- CreateIndex
CREATE INDEX "diet_meal_logs_plan_id_date_idx" ON "diet_meal_logs"("plan_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "diet_meal_logs_patient_id_plan_id_date_meal_id_key" ON "diet_meal_logs"("patient_id", "plan_id", "date", "meal_id");

-- CreateIndex
CREATE INDEX "diet_swap_logs_plan_id_date_idx" ON "diet_swap_logs"("plan_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "diet_swap_logs_patient_id_plan_id_date_item_id_key" ON "diet_swap_logs"("patient_id", "plan_id", "date", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "water_logs_patient_id_date_key" ON "water_logs"("patient_id", "date");

-- CreateIndex
CREATE INDEX "patient_invites_nutritionist_id_status_created_at_idx" ON "patient_invites"("nutritionist_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "patient_invites_email_status_idx" ON "patient_invites"("email", "status");

-- CreateIndex
CREATE INDEX "patient_invites_patient_id_idx" ON "patient_invites"("patient_id");

-- CreateIndex
CREATE INDEX "foods_nutritionist_id_idx" ON "foods"("nutritionist_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_metabolic_profiles_patient_id_nutritionist_id_key" ON "patient_metabolic_profiles"("patient_id", "nutritionist_id");

-- CreateIndex
CREATE INDEX "diet_protocols_assignee_id_status_idx" ON "diet_protocols"("assignee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "diet_protocols_nutritionist_id_assignee_id_key" ON "diet_protocols"("nutritionist_id", "assignee_id");

-- CreateIndex
CREATE INDEX "diet_meals_diet_protocol_id_order_idx" ON "diet_meals"("diet_protocol_id", "order");

-- CreateIndex
CREATE INDEX "diet_food_items_diet_meal_option_id_order_idx" ON "diet_food_items"("diet_meal_option_id", "order");

-- AddForeignKey
ALTER TABLE "foods" ADD CONSTRAINT "foods_nutritionist_id_fkey" FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_meal_options" ADD CONSTRAINT "diet_meal_options_diet_meal_id_fkey" FOREIGN KEY ("diet_meal_id") REFERENCES "diet_meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_food_items" ADD CONSTRAINT "diet_food_items_diet_meal_option_id_fkey" FOREIGN KEY ("diet_meal_option_id") REFERENCES "diet_meal_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_item_substitutes" ADD CONSTRAINT "diet_item_substitutes_diet_food_item_id_fkey" FOREIGN KEY ("diet_food_item_id") REFERENCES "diet_food_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_item_substitutes" ADD CONSTRAINT "diet_item_substitutes_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_meal_logs" ADD CONSTRAINT "diet_meal_logs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_meal_logs" ADD CONSTRAINT "diet_meal_logs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "diet_protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_swap_logs" ADD CONSTRAINT "diet_swap_logs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_swap_logs" ADD CONSTRAINT "diet_swap_logs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "diet_protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "water_logs" ADD CONSTRAINT "water_logs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_invites" ADD CONSTRAINT "patient_invites_nutritionist_id_fkey" FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_invites" ADD CONSTRAINT "patient_invites_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A nutritionist can have at most one pending invite per email (mirrors student_invites).
CREATE UNIQUE INDEX "patient_invites_nutritionist_id_email_pending_key"
  ON "patient_invites"("nutritionist_id", "email")
  WHERE "status" = 'pending';

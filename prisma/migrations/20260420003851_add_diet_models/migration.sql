-- CreateTable
CREATE TABLE "nutritionist_patients" (
    "id" UUID NOT NULL,
    "nutritionist_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "nutritionist_patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foods" (
    "id" UUID NOT NULL,
    "food_group_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "taco_id" VARCHAR(50),
    "tbca_id" VARCHAR(50),
    "source" TEXT NOT NULL DEFAULT 'taco',
    "edible_portion_percent" DECIMAL(5,2),
    "serving_size_g" DECIMAL(10,2),
    "serving_size_description" VARCHAR(100),
    "energy_kcal" DECIMAL(8,2),
    "energy_kj" DECIMAL(8,2),
    "protein_g" DECIMAL(6,2),
    "total_fat_g" DECIMAL(6,2),
    "carbohydrates_g" DECIMAL(6,2),
    "fiber_g" DECIMAL(6,2),
    "ash_g" DECIMAL(6,2),
    "saturated_fat_g" DECIMAL(6,2),
    "monounsaturated_fat_g" DECIMAL(6,2),
    "polyunsaturated_fat_g" DECIMAL(6,2),
    "trans_fat_g" DECIMAL(6,2),
    "cholesterol_mg" DECIMAL(8,2),
    "calcium_mg" DECIMAL(8,2),
    "phosphorus_mg" DECIMAL(8,2),
    "iron_mg" DECIMAL(8,2),
    "sodium_mg" DECIMAL(8,2),
    "potassium_mg" DECIMAL(8,2),
    "copper_mg" DECIMAL(8,2),
    "magnesium_mg" DECIMAL(8,2),
    "manganese_mg" DECIMAL(8,2),
    "zinc_mg" DECIMAL(8,2),
    "selenium_ug" DECIMAL(8,2),
    "vitamin_a_ug_rae" DECIMAL(8,2),
    "vitamin_d_ug" DECIMAL(8,2),
    "vitamin_e_mg" DECIMAL(8,2),
    "vitamin_k_ug" DECIMAL(8,2),
    "thiamine_mg" DECIMAL(8,2),
    "riboflavin_mg" DECIMAL(8,2),
    "niacin_mg" DECIMAL(8,2),
    "vitamin_b6_mg" DECIMAL(8,2),
    "folate_ug" DECIMAL(8,2),
    "vitamin_b12_ug" DECIMAL(8,2),
    "vitamin_c_mg" DECIMAL(8,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "foods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_metabolic_profiles" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "nutritionist_id" UUID NOT NULL,
    "weight_kg" DECIMAL(6,2),
    "height_cm" DECIMAL(6,2),
    "lean_body_mass_kg" DECIMAL(6,2),
    "tmb_formula" TEXT,
    "tmb_kcal" DECIMAL(8,2),
    "activity_level" TEXT,
    "pal_multiplier" DECIMAL(4,3),
    "get_kcal" DECIMAL(8,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "patient_metabolic_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_protocol_templates" (
    "id" UUID NOT NULL,
    "nutritionist_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "diet_type" TEXT,
    "goal_type" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_protocol_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_template_meals" (
    "id" UUID NOT NULL,
    "diet_protocol_template_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "meal_type" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "scheduled_time" VARCHAR(10),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_template_meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_template_food_items" (
    "id" UUID NOT NULL,
    "diet_template_meal_id" UUID NOT NULL,
    "food_id" UUID,
    "food_name" VARCHAR(255) NOT NULL,
    "quantity_g" DECIMAL(8,2) NOT NULL,
    "unit" VARCHAR(20) NOT NULL DEFAULT 'g',
    "energy_kcal" DECIMAL(8,2),
    "protein_g" DECIMAL(6,2),
    "carbohydrates_g" DECIMAL(6,2),
    "total_fat_g" DECIMAL(6,2),
    "fiber_g" DECIMAL(6,2),
    "order" INTEGER NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_template_food_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_protocols" (
    "id" UUID NOT NULL,
    "nutritionist_id" UUID NOT NULL,
    "assignee_id" UUID NOT NULL,
    "diet_protocol_template_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "start_date" DATE NOT NULL,
    "expiration_date" DATE,
    "diet_type" TEXT,
    "goal_type" TEXT,
    "tmb_formula" TEXT,
    "tmb_kcal" DECIMAL(8,2),
    "activity_level" TEXT,
    "get_kcal" DECIMAL(8,2),
    "daily_caloric_target" DECIMAL(8,2),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_meals" (
    "id" UUID NOT NULL,
    "diet_protocol_id" UUID NOT NULL,
    "template_meal_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "meal_type" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "scheduled_time" VARCHAR(10),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diet_food_items" (
    "id" UUID NOT NULL,
    "diet_meal_id" UUID NOT NULL,
    "food_id" UUID,
    "food_name" VARCHAR(255) NOT NULL,
    "quantity_g" DECIMAL(8,2) NOT NULL,
    "unit" VARCHAR(20) NOT NULL DEFAULT 'g',
    "energy_kcal" DECIMAL(8,2),
    "protein_g" DECIMAL(6,2),
    "carbohydrates_g" DECIMAL(6,2),
    "total_fat_g" DECIMAL(6,2),
    "fiber_g" DECIMAL(6,2),
    "order" INTEGER NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diet_food_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nutritionist_patients_nutritionist_id_patient_id_key" ON "nutritionist_patients"("nutritionist_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "food_groups_code_key" ON "food_groups"("code");

-- CreateIndex
CREATE UNIQUE INDEX "foods_taco_id_key" ON "foods"("taco_id");

-- CreateIndex
CREATE UNIQUE INDEX "foods_tbca_id_key" ON "foods"("tbca_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_metabolic_profiles_patient_id_key" ON "patient_metabolic_profiles"("patient_id");

-- AddForeignKey
ALTER TABLE "nutritionist_patients" ADD CONSTRAINT "nutritionist_patients_nutritionist_id_fkey" FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutritionist_patients" ADD CONSTRAINT "nutritionist_patients_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "foods" ADD CONSTRAINT "foods_food_group_id_fkey" FOREIGN KEY ("food_group_id") REFERENCES "food_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_metabolic_profiles" ADD CONSTRAINT "patient_metabolic_profiles_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_metabolic_profiles" ADD CONSTRAINT "patient_metabolic_profiles_nutritionist_id_fkey" FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_protocol_templates" ADD CONSTRAINT "diet_protocol_templates_nutritionist_id_fkey" FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_template_meals" ADD CONSTRAINT "diet_template_meals_diet_protocol_template_id_fkey" FOREIGN KEY ("diet_protocol_template_id") REFERENCES "diet_protocol_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_template_food_items" ADD CONSTRAINT "diet_template_food_items_diet_template_meal_id_fkey" FOREIGN KEY ("diet_template_meal_id") REFERENCES "diet_template_meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_template_food_items" ADD CONSTRAINT "diet_template_food_items_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_protocols" ADD CONSTRAINT "diet_protocols_nutritionist_id_fkey" FOREIGN KEY ("nutritionist_id") REFERENCES "nutritionists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_protocols" ADD CONSTRAINT "diet_protocols_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_protocols" ADD CONSTRAINT "diet_protocols_diet_protocol_template_id_fkey" FOREIGN KEY ("diet_protocol_template_id") REFERENCES "diet_protocol_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_meals" ADD CONSTRAINT "diet_meals_diet_protocol_id_fkey" FOREIGN KEY ("diet_protocol_id") REFERENCES "diet_protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_food_items" ADD CONSTRAINT "diet_food_items_diet_meal_id_fkey" FOREIGN KEY ("diet_meal_id") REFERENCES "diet_meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diet_food_items" ADD CONSTRAINT "diet_food_items_food_id_fkey" FOREIGN KEY ("food_id") REFERENCES "foods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

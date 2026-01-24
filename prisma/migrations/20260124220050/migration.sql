/*
  Warnings:

  - You are about to drop the column `birthdate` on the `students` table. All the data in the column will be lost.
  - You are about to drop the column `gender` on the `students` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `students` table. All the data in the column will be lost.
  - You are about to drop the column `avatar` on the `trainers` table. All the data in the column will be lost.
  - You are about to drop the column `birth_date` on the `trainers` table. All the data in the column will be lost.
  - You are about to drop the column `first_name` on the `trainers` table. All the data in the column will be lost.
  - You are about to drop the column `last_name` on the `trainers` table. All the data in the column will be lost.
  - You are about to drop the column `service_types` on the `trainers` table. All the data in the column will be lost.
  - You are about to drop the column `avatar` on the `users` table. All the data in the column will be lost.
  - The `roles` column on the `users` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "student_health_details" ALTER COLUMN "conditions" DROP NOT NULL,
ALTER COLUMN "conditions" DROP DEFAULT,
ALTER COLUMN "conditions" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "students" DROP COLUMN "birthdate",
DROP COLUMN "gender",
DROP COLUMN "name",
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "trainers" DROP COLUMN "avatar",
DROP COLUMN "birth_date",
DROP COLUMN "first_name",
DROP COLUMN "last_name",
DROP COLUMN "service_types",
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "service_mode" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" DROP COLUMN "avatar",
ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "birth_date" DATE,
ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "last_name" TEXT,
DROP COLUMN "roles",
ADD COLUMN     "roles" TEXT[];

-- DropEnum
DROP TYPE "Role";

-- CreateTable
CREATE TABLE "nutritionists" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "council_number" TEXT,
    "specialties" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "nutritionists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nutritionists_user_id_key" ON "nutritionists"("user_id");

-- AddForeignKey
ALTER TABLE "nutritionists" ADD CONSTRAINT "nutritionists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

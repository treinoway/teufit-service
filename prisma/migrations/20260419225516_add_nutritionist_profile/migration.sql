/*
  Warnings:

  - You are about to drop the column `council_number` on the `nutritionists` table. All the data in the column will be lost.
  - You are about to drop the column `specialties` on the `nutritionists` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "nutritionists" DROP COLUMN "council_number",
DROP COLUMN "specialties",
ADD COLUMN     "clinic_name" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "professional_document" TEXT,
ADD COLUMN     "profile_completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "service_mode" TEXT;

/*
  Warnings:

  - You are about to drop the column `name` on the `trainers` table. All the data in the column will be lost.
  - You are about to drop the column `avatar` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[user_id]` on the table `students` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[user_id]` on the table `trainers` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `birth_date` to the `trainers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `first_name` to the `trainers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_name` to the `trainers` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "students_user_id_idx";

-- DropIndex
DROP INDEX "trainers_user_id_idx";

-- AlterTable
ALTER TABLE "trainers" DROP COLUMN "name",
ADD COLUMN     "birth_date" DATE NOT NULL,
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "gym_name" TEXT,
ADD COLUMN     "last_name" TEXT NOT NULL,
ADD COLUMN     "professional_document" TEXT;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "avatar";

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "street" TEXT NOT NULL,
    "street_line_2" TEXT,
    "house_number" TEXT NOT NULL,
    "neighoborhood" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "country" TEXT NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "socials_networks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instagram" TEXT,
    "whatsapp" TEXT,
    "x" TEXT,
    "threads" TEXT,
    "youtube" TEXT,

    CONSTRAINT "socials_networks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "socials_networks_user_id_key" ON "socials_networks"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_key" ON "students"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trainers_user_id_key" ON "trainers"("user_id");

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "socials_networks" ADD CONSTRAINT "socials_networks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

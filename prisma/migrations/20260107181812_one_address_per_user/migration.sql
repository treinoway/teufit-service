/*
  Warnings:

  - A unique constraint covering the columns `[user_id]` on the table `addresses` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "addresses_user_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "addresses_user_id_key" ON "addresses"("user_id");

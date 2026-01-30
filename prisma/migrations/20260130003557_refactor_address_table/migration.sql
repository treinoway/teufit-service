/*
  Warnings:

  - You are about to drop the column `house_number` on the `addresses` table. All the data in the column will be lost.
  - You are about to drop the column `neighoborhood` on the `addresses` table. All the data in the column will be lost.
  - You are about to drop the column `street` on the `addresses` table. All the data in the column will be lost.
  - You are about to drop the column `street_line_2` on the `addresses` table. All the data in the column will be lost.
  - You are about to drop the `user_waitlist` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "addresses" DROP COLUMN "house_number",
DROP COLUMN "neighoborhood",
DROP COLUMN "street",
DROP COLUMN "street_line_2",
ADD COLUMN     "country_code" TEXT,
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "line1" TEXT,
ADD COLUMN     "line2" TEXT,
ADD COLUMN     "neighborhood" TEXT,
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "state_code" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6),
ALTER COLUMN "city" DROP NOT NULL,
ALTER COLUMN "country" DROP NOT NULL;
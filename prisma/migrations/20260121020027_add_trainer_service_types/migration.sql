-- AlterTable
ALTER TABLE "trainers" ADD COLUMN     "service_types" TEXT[] DEFAULT ARRAY[]::TEXT[];

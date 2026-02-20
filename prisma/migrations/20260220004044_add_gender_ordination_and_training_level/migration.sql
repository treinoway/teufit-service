-- AlterTable
ALTER TABLE "training_protocol_templates" ADD COLUMN     "gender_ordination" TEXT,
ADD COLUMN     "training_level" TEXT;

-- AlterTable
ALTER TABLE "training_protocols" ADD COLUMN     "gender_ordination" TEXT,
ADD COLUMN     "training_level" TEXT;

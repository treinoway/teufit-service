-- AlterTable
ALTER TABLE "anamneses"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "parent_id" UUID;

-- AddForeignKey
ALTER TABLE "anamneses"
  ADD CONSTRAINT "anamneses_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "anamneses"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Anamnesis catalog: category (screening | general | weight_loss | hypertrophy | special_population)
-- and seed_key (stable key of system-seeded templates, internal only).
-- Both nullable: existing rows stay uncategorized and nothing needs a backfill.
ALTER TABLE "anamneses" ADD COLUMN     "category" TEXT,
ADD COLUMN     "seed_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "anamneses_seed_key_key" ON "anamneses"("seed_key");

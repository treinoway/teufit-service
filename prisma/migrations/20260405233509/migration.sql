-- DropForeignKey
ALTER TABLE "point_transactions" DROP CONSTRAINT "point_transactions_challenge_id_fkey";

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

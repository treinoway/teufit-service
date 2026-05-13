import { PrismaClient } from '@prisma/client';
import { recomputeTrainingDuration } from '../src/helpers/workout-duration.js';

const prisma = new PrismaClient();

async function main() {
  const trainings = await prisma.training.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  console.log(`Backfilling ${trainings.length} training(s)...`);

  for (const training of trainings) {
    await recomputeTrainingDuration(prisma, training.id);
  }

  console.log('Backfill complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { TrainingCategory, PrescriptionMode } from '../constants/training.js';

const EXAMPLE_ROUTINE_NAME = 'Rotina de exemplo';
const EXAMPLE_ROUTINE_DESCRIPTION = 'Uma rotina pronta para você conhecer o Teufit. Edite, duplique ou apague quando quiser.';
const EXAMPLE_TRAINING_NAME = 'Treino A';
const EXAMPLE_EXERCISE_LIMIT = 6;
const EXAMPLE_SETS = 3;
const EXAMPLE_REPETITIONS = Object.freeze({ min: 10, max: 12 });

// Builds the junction row that snapshots a public exercise template into the example training.
function buildExampleExerciseRow({ exerciseTemplate, trainingTemplateId, order }) {
  return {
    trainingTemplateId,
    exerciseTemplateId: exerciseTemplate.id,
    order,
    name: exerciseTemplate.name,
    type: exerciseTemplate.type,
    videoUrl: exerciseTemplate.videoUrl ?? null,
    gifUrl: exerciseTemplate.gifUrl ?? null,
    sets: EXAMPLE_SETS,
    repetitions: { ...EXAMPLE_REPETITIONS },
    prescriptionMode: PrescriptionMode.REPS,
  };
}

/**
 * Seed one example routine (isExample) for a new trainer from public exercise templates.
 *
 * @param {{ trainerId: string, tx: import('@prisma/client').PrismaClient }} params
 */
export async function seedExampleRoutine({ trainerId, tx }) {
  const exerciseTemplates = await tx.exerciseTemplate.findMany({
    where: { isPublic: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: EXAMPLE_EXERCISE_LIMIT,
  });

  if (exerciseTemplates.length === 0) return;

  const trainingTemplate = await tx.trainingTemplate.create({
    data: {
      trainerId,
      name: EXAMPLE_TRAINING_NAME,
      category: TrainingCategory.STRENGTH,
      isExample: true,
    },
  });

  await tx.trainingTemplateExerciseTemplate.createMany({
    data: exerciseTemplates.map((exerciseTemplate, order) =>
      buildExampleExerciseRow({ exerciseTemplate, trainingTemplateId: trainingTemplate.id, order }),
    ),
  });

  const protocolTemplate = await tx.trainingProtocolTemplate.create({
    data: {
      trainerId,
      name: EXAMPLE_ROUTINE_NAME,
      description: EXAMPLE_ROUTINE_DESCRIPTION,
      isExample: true,
    },
  });

  await tx.protocolTemplateTraining.create({
    data: { protocolTemplateId: protocolTemplate.id, trainingTemplateId: trainingTemplate.id, order: 0 },
  });
}

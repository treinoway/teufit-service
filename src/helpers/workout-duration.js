import { PrescriptionMode, WorkoutDurationConstants } from '../constants/training.js';

const {
  SECONDS_PER_REP,
  TRANSITION_SECONDS,
  WARMUP_OVERHEAD_SECONDS,
  DEFAULT_REST_SECONDS,
  DEFAULT_REPS_FALLBACK,
} = WorkoutDurationConstants;

export function resolveReps(repetitions) {
  if (repetitions === null || repetitions === undefined) {
    return DEFAULT_REPS_FALLBACK;
  }

  if (typeof repetitions === 'number') {
    return repetitions > 0 ? repetitions : DEFAULT_REPS_FALLBACK;
  }

  if (typeof repetitions === 'object') {
    const min = Number(repetitions.min);
    const max = Number(repetitions.max);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) {
      return Math.ceil((min + max) / 2);
    }
  }

  return DEFAULT_REPS_FALLBACK;
}

export function estimateExerciseDuration(exercise) {
  if (exercise.substituteForExerciseId != null || exercise.deletedAt != null) {
    return 0;
  }

  const sets = exercise.sets ?? 1;
  if (sets <= 0) return 0;

  let workSeconds;
  if (exercise.prescriptionMode === PrescriptionMode.DURATION && exercise.duration > 0) {
    workSeconds = sets * exercise.duration;
  } else {
    workSeconds = sets * resolveReps(exercise.repetitions) * SECONDS_PER_REP;
  }

  const restSeconds = Math.max(0, sets - 1) * (exercise.restInterval ?? DEFAULT_REST_SECONDS);

  return workSeconds + restSeconds + TRANSITION_SECONDS;
}

export function estimateWorkoutDuration(training) {
  const exercises = training.exercises ?? [];
  const total = exercises.reduce((sum, exercise) => sum + estimateExerciseDuration(exercise), 0);

  if (total === 0) return 0;

  return total + WARMUP_OVERHEAD_SECONDS;
}

export async function recomputeTrainingDuration(tx, trainingId) {
  const exercises = await tx.exercise.findMany({
    where: { trainingId, deletedAt: null },
    select: {
      sets: true,
      repetitions: true,
      duration: true,
      prescriptionMode: true,
      restInterval: true,
      substituteForExerciseId: true,
    },
  });

  const estimatedDurationSeconds = estimateWorkoutDuration({ exercises });

  await tx.training.update({
    where: { id: trainingId },
    data: { estimatedDurationSeconds },
  });
}

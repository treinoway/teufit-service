import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import {
  buildError,
  validateExerciseType,
  validateRepetitions,
  validatePrescriptionMode,
  applyPrescriptionModeExclusivity,
  resolvePrescriptionMode,
} from '../helpers/training-validators.js';
import { PrescriptionMode } from '../constants/training.js';

/**
 * Verify training ownership (trainer context)
 */
async function verifyTrainingOwnership(trainingId, trainerId) {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: { trainingProtocol: true },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.trainerId !== trainerId) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
  }

  return training;
}

function buildExerciseData(data, trainingId, exerciseTemplateId = null) {
  const resolvedMode = data.prescriptionMode ?? PrescriptionMode.REPS;
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, data);

  return {
    trainingId,
    exerciseTemplateId: exerciseTemplateId || null,
    name: data.name,
    type: data.type,
    videoUrl: data.videoUrl || null,
    order: data.order !== undefined ? data.order : 0,
    sets: data.sets ?? null,
    repetitions,
    duration,
    prescriptionMode: resolvedMode,
    hasLoad: data.hasLoad !== undefined ? data.hasLoad : false,
    suggestedLoad: data.suggestedLoad ?? null,
    restInterval: data.restInterval ?? null,
    notes: data.notes ?? null,
  };
}

function normalizeExercisePrescriptionMode(exercise) {
  if (!exercise) return exercise;
  return {
    ...exercise,
    prescriptionMode: resolvePrescriptionMode(exercise.prescriptionMode, exercise),
  };
}

/**
 * Create a new exercise within a training
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} trainingId - Training ID
 * @param {object} data - Exercise data
 * @returns {Promise<object>} Created exercise
 */
export async function createExercise(userId, trainingId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);
  validateExerciseType(data.type);
  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  const exercise = await prisma.exercise.create({
    data: buildExerciseData(data, trainingId),
  });

  return normalizeExercisePrescriptionMode(exercise);
}

/**
 * Create an exercise from a template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} trainingId - Training ID
 * @param {string} templateId - Exercise template ID
 * @param {object} data - Override data
 * @returns {Promise<object>} Created exercise
 */
export async function createFromTemplate(userId, trainingId, templateId, data = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);

  const template = await prisma.exerciseTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  if (template.trainerId !== trainer.id && !template.isPublic) {
    throw buildError('FORBIDDEN_PRIVATE_TEMPLATE', 'This template is private', 403);
  }

  const exerciseData = {
    name: data.name || template.name,
    type: data.type || template.type,
    videoUrl: data.videoUrl !== undefined ? data.videoUrl : template.videoUrl,
    order: data.order !== undefined ? data.order : 0,
    sets: data.sets !== undefined ? data.sets : template.sets,
    repetitions: data.repetitions !== undefined ? data.repetitions : template.repetitions,
    duration: data.duration !== undefined ? data.duration : template.duration,
    prescriptionMode: data.prescriptionMode !== undefined
      ? data.prescriptionMode
      : resolvePrescriptionMode(template.prescriptionMode, template),
    hasLoad: data.hasLoad !== undefined ? data.hasLoad : template.hasLoad,
    suggestedLoad: data.suggestedLoad !== undefined ? data.suggestedLoad : template.suggestedLoad,
    restInterval: data.restInterval !== undefined ? data.restInterval : template.restInterval,
    notes: data.notes !== undefined ? data.notes : template.notes,
  };

  const exercise = await prisma.exercise.create({
    data: {
      ...buildExerciseData(exerciseData, trainingId, template.id),
      exerciseTemplateId: template.id,
    },
  });

  return normalizeExercisePrescriptionMode(exercise);
}

/**
 * Get exercises by training
 *
 * @param {string} userId - User ID
 * @param {string} trainingId - Training ID
 * @param {string} context - Context: 'trainer' or 'assignee'
 * @returns {Promise<object[]>} List of exercises
 */
export async function getExercisesByTraining(userId, trainingId, context) {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: { trainingProtocol: true },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    if (training.trainingProtocol.trainerId !== trainer.id) {
      throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
    }
  } else if (context === 'assignee') {
    if (training.trainingProtocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_TRAINING', 'This training is not assigned to you', 403);
    }
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  const exercises = await prisma.exercise.findMany({
    where: { trainingId, deletedAt: null },
    include: {
      exerciseTemplate: {
        select: { id: true, name: true },
      },
    },
    orderBy: { order: 'asc' },
  });

  return exercises.map(normalizeExercisePrescriptionMode);
}

/**
 * Get a single exercise by ID
 *
 * @param {string} userId - User ID
 * @param {string} exerciseId - Exercise ID
 * @param {string} context - Context: 'trainer' or 'assignee'
 * @returns {Promise<object>} Exercise
 */
export async function getExerciseById(userId, exerciseId, context) {
  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      training: {
        include: { trainingProtocol: true },
      },
      exerciseTemplate: {
        select: { id: true, name: true, type: true, videoUrl: true },
      },
    },
  });

  if (!exercise || exercise.deletedAt || exercise.training?.deletedAt || exercise.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Exercise not found', 404);
  }

  const protocol = exercise.training.trainingProtocol;

  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    if (protocol.trainerId !== trainer.id) {
      throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
    }
  } else if (context === 'assignee') {
    if (protocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_EXERCISE', 'This exercise is not assigned to you', 403);
    }
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  return normalizeExercisePrescriptionMode(exercise);
}

/**
 * Update an exercise
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} exerciseId - Exercise ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated exercise
 */
export async function updateExercise(userId, exerciseId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      training: { include: { trainingProtocol: true } },
    },
  });

  if (!exercise || exercise.deletedAt || exercise.training?.deletedAt || exercise.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Exercise not found', 404);
  }

  if (exercise.training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
  }

  if (data.type) {
    validateExerciseType(data.type);
  }
  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.videoUrl !== undefined) updateData.videoUrl = data.videoUrl;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.sets !== undefined) updateData.sets = data.sets;
  if (data.hasLoad !== undefined) updateData.hasLoad = data.hasLoad;
  if (data.suggestedLoad !== undefined) updateData.suggestedLoad = data.suggestedLoad;
  if (data.restInterval !== undefined) updateData.restInterval = data.restInterval;
  if (data.notes !== undefined) updateData.notes = data.notes;

  if (data.prescriptionMode !== undefined) {
    const { repetitions, duration } = applyPrescriptionModeExclusivity(data.prescriptionMode, data);
    updateData.prescriptionMode = data.prescriptionMode;
    updateData.repetitions = repetitions;
    updateData.duration = duration;
  } else {
    if (data.repetitions !== undefined) updateData.repetitions = data.repetitions;
    if (data.duration !== undefined) updateData.duration = data.duration;
  }

  const updated = await prisma.exercise.update({
    where: { id: exerciseId },
    data: updateData,
  });

  return normalizeExercisePrescriptionMode(updated);
}

/**
 * Reorder all exercises within a training atomically.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} trainingId - Training ID
 * @param {string[]} exerciseIds - Full ordered list of exercise IDs in the desired order
 * @returns {Promise<{trainingId: string, exercises: Array<{id: string, name: string, order: number}>}>}
 */
export async function reorderExercisesInTraining(userId, trainingId, exerciseIds) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    select: {
      id: true,
      deletedAt: true,
      trainingProtocol: {
        select: { trainerId: true, deletedAt: true },
      },
      exercises: {
        where: { deletedAt: null },
        select: { id: true, name: true },
      },
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
  }

  const activeExercises = training.exercises;
  const activeExerciseIds = new Set(activeExercises.map((e) => e.id));

  const validationDetails = validateExerciseIdsForReorder(exerciseIds, activeExerciseIds);
  if (validationDetails) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Invalid exerciseIds for reorder',
      details: validationDetails,
    });
  }

  const activeExerciseById = Object.fromEntries(activeExercises.map((e) => [e.id, e]));

  await prisma.$transaction((tx) =>
    Promise.all(
      exerciseIds.map((id, index) =>
        tx.exercise.update({
          where: { id },
          data: { order: index },
        }),
      ),
    ),
  );

  return {
    trainingId,
    exercises: exerciseIds.map((id, index) => ({
      id,
      name: activeExerciseById[id].name,
      order: index,
    })),
  };
}

function validateExerciseIdsForReorder(exerciseIds, activeExerciseIds) {
  if (!exerciseIds || exerciseIds.length === 0) {
    return { reason: 'exerciseIds must be a non-empty array' };
  }

  const seen = new Set();
  const duplicates = [];
  for (const id of exerciseIds) {
    if (seen.has(id)) {
      duplicates.push(id);
    }
    seen.add(id);
  }
  if (duplicates.length > 0) {
    return { reason: 'duplicate IDs', duplicates };
  }

  const unknownIds = exerciseIds.filter((id) => !activeExerciseIds.has(id));
  if (unknownIds.length > 0) {
    return { reason: 'unknown or soft-deleted exercise IDs', unknownIds };
  }

  if (exerciseIds.length !== activeExerciseIds.size) {
    return {
      reason: 'length mismatch',
      expected: activeExerciseIds.size,
      received: exerciseIds.length,
    };
  }

  return null;
}

/**
 * Soft delete an exercise
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} exerciseId - Exercise ID
 * @returns {Promise<object>} Deleted exercise
 */
export async function deleteExercise(userId, exerciseId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      training: { include: { trainingProtocol: true } },
    },
  });

  if (!exercise || exercise.deletedAt || exercise.training?.deletedAt || exercise.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Exercise not found', 404);
  }

  if (exercise.training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
  }

  const deleted = await prisma.exercise.update({
    where: { id: exerciseId },
    data: { deletedAt: new Date() },
  });

  return deleted;
}

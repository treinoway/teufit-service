import { randomUUID } from 'crypto';
import { prisma } from '../db.js';
import {
  buildError,
  validateCategory,
  validateBodySegment,
  validateWeekDay,
  resolvePrescriptionMode,
  applyPrescriptionModeExclusivity,
} from '../helpers/training-validators.js';
import { recomputeTrainingDuration } from '../helpers/workout-duration.js';
import { withDeadlockRetry } from '../helpers/db-retry.js';

/**
 * Verify protocol ownership (trainer context)
 */
async function verifyProtocolOwnership(protocolId, trainerId) {
  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Training protocol not found', 404);
  }

  if (protocol.trainerId !== trainerId) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
  }

  return protocol;
}

/**
 * Create a new training within a protocol
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} protocolId - Protocol ID
 * @param {object} data - Training data
 * @returns {Promise<object>} Created training
 */
export async function createTraining(userId, protocolId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyProtocolOwnership(protocolId, trainer.id);

  validateCategory(data.category);

  if (data.bodySegment) {
    validateBodySegment(data.bodySegment);
  }

  if (data.weekDay) {
    validateWeekDay(data.weekDay);
  }

  const training = await prisma.training.create({
    data: {
      trainingProtocolId: protocolId,
      trainingTemplateId: data.trainingTemplateId || null,
      name: data.name,
      description: data.description || null,
      category: data.category,
      bodySegment: data.bodySegment || null,
      weekDay: data.weekDay || null,
      order: data.order !== undefined ? data.order : 0,
      notes: data.notes || null,
      estimatedDurationSeconds: 0,
    },
  });

  return training;
}

/**
 * Get trainings by protocol
 *
 * @param {string} userId - User ID
 * @param {string} protocolId - Protocol ID
 * @param {string} context - Context: 'trainer' or 'assignee'
 * @returns {Promise<object[]>} List of trainings
 */
export async function getTrainingsByProtocol(userId, protocolId, context) {
  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    await verifyProtocolOwnership(protocolId, trainer.id);
  } else if (context === 'assignee') {
    const protocol = await prisma.trainingProtocol.findUnique({
      where: { id: protocolId },
    });

    if (!protocol || protocol.deletedAt) {
      throw buildError('PROTOCOL_NOT_FOUND', 'Training protocol not found', 404);
    }

    if (protocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_PROTOCOL', 'This protocol is not assigned to you', 403);
    }
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  const trainings = await prisma.training.findMany({
    where: {
      trainingProtocolId: protocolId,
      deletedAt: null,
    },
    include: {
      trainingTemplate: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { order: 'asc' },
  });

  return trainings;
}

/**
 * Get a single training by ID
 *
 * @param {string} userId - User ID
 * @param {string} trainingId - Training ID
 * @param {string} context - Context: 'trainer' or 'assignee'
 * @returns {Promise<object>} Training
 */
export async function getTrainingById(userId, trainingId, context) {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: {
      trainingProtocol: true,
      trainingTemplate: {
        select: {
          id: true,
          name: true,
          description: true,
          category: true,
          bodySegment: true,
          tags: true,
        },
      },
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol.deletedAt) {
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

  return training;
}

/**
 * Update a training
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} trainingId - Training ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated training
 */
export async function updateTraining(userId, trainingId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: {
      trainingProtocol: true,
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
  }

  if (data.category) {
    validateCategory(data.category);
  }

  if (data.bodySegment) {
    validateBodySegment(data.bodySegment);
  }

  if (data.weekDay) {
    validateWeekDay(data.weekDay);
  }

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.category !== undefined) updateData.category = data.category;
  if (data.bodySegment !== undefined) updateData.bodySegment = data.bodySegment;
  if (data.weekDay !== undefined) updateData.weekDay = data.weekDay;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await prisma.training.update({
    where: { id: trainingId },
    data: updateData,
  });

  return updated;
}

/**
 * Soft delete a training
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} trainingId - Training ID
 * @returns {Promise<object>} Deleted training
 */
export async function deleteTraining(userId, trainingId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: {
      trainingProtocol: true,
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
  }

  const deleted = await prisma.training.update({
    where: { id: trainingId },
    data: {
      deletedAt: new Date(),
    },
  });

  return deleted;
}

/**
 * Create a training from a template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} protocolId - Protocol ID
 * @param {string} templateId - Template ID
 * @param {object} data - Additional training data
 * @returns {Promise<object>} Created training
 */
export async function importFromTemplate(userId, protocolId, templateId, data = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyProtocolOwnership(protocolId, trainer.id);

  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
    include: {
      trainingTemplateExerciseTemplates: {
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  if (template.trainerId !== trainer.id && !template.isPublic) {
    throw buildError('FORBIDDEN_PRIVATE_TEMPLATE', 'This template is private', 403);
  }

  if (data.weekDay) {
    validateWeekDay(data.weekDay);
  }

  const training = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const createdTraining = await tx.training.create({
      data: {
        trainingProtocolId: protocolId,
        trainingTemplateId: template.id,
        name: data.name || template.name,
        description: data.description || template.description,
        category: data.category || template.category,
        bodySegment: data.bodySegment || template.bodySegment,
        weekDay: data.weekDay || null,
        order: data.order !== undefined ? data.order : 0,
        notes: data.notes || null,
      },
    });

    // Build a map of old supersetGroupId → fresh UUID so that every import
    // produces its own group IDs and two imports of the same template never collide.
    const supersetGroupIdMap = new Map();
    for (const junctionRow of template.trainingTemplateExerciseTemplates) {
      if (junctionRow.supersetGroupId && !supersetGroupIdMap.has(junctionRow.supersetGroupId)) {
        supersetGroupIdMap.set(junctionRow.supersetGroupId, randomUUID());
      }
    }

    for (const junctionRow of template.trainingTemplateExerciseTemplates) {
      const resolvedMode = resolvePrescriptionMode(junctionRow.prescriptionMode, junctionRow);
      const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, junctionRow);

      await tx.exercise.create({
        data: {
          trainingId: createdTraining.id,
          exerciseTemplateId: junctionRow.exerciseTemplateId,
          name: junctionRow.name,
          type: junctionRow.type,
          videoUrl: junctionRow.videoUrl ?? null,
          gifUrl: junctionRow.gifUrl ?? null,
          order: junctionRow.order,
          supersetGroupId: junctionRow.supersetGroupId
            ? supersetGroupIdMap.get(junctionRow.supersetGroupId)
            : null,
          supersetOrder: junctionRow.supersetOrder ?? 0,
          sets: junctionRow.sets ?? null,
          repetitions,
          duration,
          prescriptionMode: resolvedMode,
          hasLoad: junctionRow.hasLoad ?? false,
          suggestedLoad: junctionRow.suggestedLoad ?? null,
          restInterval: junctionRow.restInterval ?? null,
          notes: junctionRow.notes ?? null,
          intensity: junctionRow.intensity ?? null,
        },
      });
    }

    await recomputeTrainingDuration(tx, createdTraining.id);

    return tx.training.findUnique({
      where: { id: createdTraining.id },
      include: {
        exercises: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
        },
      },
    });
  }));

  return training;
}

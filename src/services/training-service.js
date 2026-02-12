import { prisma } from '../db.js';
import {
  buildError,
  validateCategory,
  validateBodySegment,
  validateWeekDays,
} from '../helpers/training-validators.js';

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
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify protocol ownership
  await verifyProtocolOwnership(protocolId, trainer.id);

  // 3. Validate category
  validateCategory(data.category);

  // 4. Validate body segment if provided
  if (data.bodySegment) {
    validateBodySegment(data.bodySegment);
  }

  // 5. Create training
  const training = await prisma.training.create({
    data: {
      trainingProtocolId: protocolId,
      trainingTemplateId: data.trainingTemplateId || null,
      name: data.name,
      description: data.description || null,
      category: data.category,
      bodySegment: data.bodySegment || null,
      order: data.order !== undefined ? data.order : 0,
      notes: data.notes || null,
    },
  });

  return training;
}

/**
 * Get trainings by protocol
 *
 * @param {string} userId - User ID
 * @param {string} protocolId - Protocol ID
 * @param {string} context - Context: 'trainer' or 'student'
 * @returns {Promise<object[]>} List of trainings
 */
export async function getTrainingsByProtocol(userId, protocolId, context) {
  if (context === 'trainer') {
    // Verify trainer profile and ownership
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    await verifyProtocolOwnership(protocolId, trainer.id);
  } else if (context === 'student') {
    // Verify protocol is assigned to this user
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
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "student"');
  }

  // Fetch trainings
  const trainings = await prisma.training.findMany({
    where: {
      trainingProtocolId: protocolId,
      deletedAt: null,
    },
    include: {
      schedules: {
        orderBy: { order: 'asc' },
      },
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
 * @param {string} context - Context: 'trainer' or 'student'
 * @returns {Promise<object>} Training
 */
export async function getTrainingById(userId, trainingId, context) {
  // Fetch training
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
      schedules: {
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  // Verify access based on context
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
  } else if (context === 'student') {
    if (training.trainingProtocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_TRAINING', 'This training is not assigned to you', 403);
    }
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "student"');
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
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify training exists and protocol ownership
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

  // 3. Validate category if provided
  if (data.category) {
    validateCategory(data.category);
  }

  // 4. Validate body segment if provided
  if (data.bodySegment) {
    validateBodySegment(data.bodySegment);
  }

  // 5. Build update data
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.category !== undefined) updateData.category = data.category;
  if (data.bodySegment !== undefined) updateData.bodySegment = data.bodySegment;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.notes !== undefined) updateData.notes = data.notes;

  // 6. Update training
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
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify training exists and protocol ownership
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

  // 3. Soft delete
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
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify protocol ownership
  await verifyProtocolOwnership(protocolId, trainer.id);

  // 3. Verify template exists and is accessible
  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  // Verify access (own template or public)
  if (template.trainerId !== trainer.id && !template.isPublic) {
    throw buildError('FORBIDDEN_PRIVATE_TEMPLATE', 'This template is private', 403);
  }

  // 4. Create training from template (independent copy)
  const training = await prisma.training.create({
    data: {
      trainingProtocolId: protocolId,
      trainingTemplateId: template.id,
      name: data.name || template.name,
      description: data.description || template.description,
      category: data.category || template.category,
      bodySegment: data.bodySegment || template.bodySegment,
      order: data.order !== undefined ? data.order : 0,
      notes: data.notes || null,
    },
  });

  return training;
}

/**
 * Schedule a training on specific weekdays
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} trainingId - Training ID
 * @param {string[]} weekDays - Array of week days
 * @param {number} order - Order for the schedule
 * @returns {Promise<object[]>} Created schedules
 */
export async function scheduleTraining(userId, trainingId, weekDays, order = 0) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify training exists and protocol ownership
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

  // 3. Validate week days
  validateWeekDays(weekDays);

  // 4. Replace schedules atomically: delete existing, then insert new
  const schedules = await prisma.$transaction(async (tx) => {
    await tx.trainingSchedule.deleteMany({ where: { trainingId } });
    return Promise.all(
      weekDays.map((weekDay) =>
        tx.trainingSchedule.create({
          data: {
            trainingProtocolId: training.trainingProtocolId,
            trainingId,
            weekDay,
            order,
          },
        }),
      ),
    );
  });

  return schedules;
}

import { prisma } from '../db.js';
import { buildError, validateExerciseType, validateRepetitions } from '../helpers/training-validators.js';

function buildTemplateData(data, trainerId) {
  return {
    trainerId,
    name: data.name,
    type: data.type,
    videoUrl: data.videoUrl || null,
    isPublic: data.isPublic !== undefined ? data.isPublic : false,
    sets: data.sets ?? null,
    repetitions: data.repetitions ?? null,
    duration: data.duration ?? null,
    hasLoad: data.hasLoad !== undefined ? data.hasLoad : false,
    suggestedLoad: data.suggestedLoad ?? null,
    notes: data.notes ?? null,
  };
}

/**
 * Create a new exercise template
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Template data
 * @returns {Promise<object>} Created template
 */
export async function createExerciseTemplate(userId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  validateExerciseType(data.type);
  validateRepetitions(data.repetitions);

  const template = await prisma.exerciseTemplate.create({
    data: buildTemplateData(data, trainer.id),
  });

  return template;
}

/**
 * Get exercise templates for a trainer (own + public)
 *
 * @param {string} userId - User ID of the trainer
 * @returns {Promise<object[]>} List of templates
 */
export async function getExerciseTemplatesByTrainer(userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const templates = await prisma.exerciseTemplate.findMany({
    where: {
      deletedAt: null,
      OR: [{ trainerId: trainer.id }, { isPublic: true }],
    },
    include: {
      trainer: {
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return templates;
}

/**
 * Get public exercise templates only
 *
 * @returns {Promise<object[]>} List of public templates
 */
export async function getPublicExerciseTemplates() {
  const templates = await prisma.exerciseTemplate.findMany({
    where: { isPublic: true, deletedAt: null },
    include: {
      trainer: {
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return templates;
}

/**
 * Get a single exercise template by ID
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Template
 */
export async function getExerciseTemplateById(userId, templateId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.exerciseTemplate.findUnique({
    where: { id: templateId },
    include: {
      trainer: {
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
  });

  if (!template || template.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  if (template.trainerId !== trainer.id && !template.isPublic) {
    throw buildError('FORBIDDEN_PRIVATE_TEMPLATE', 'This template is private', 403);
  }

  return template;
}

/**
 * Update an exercise template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated template
 */
export async function updateExerciseTemplate(userId, templateId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.exerciseTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  if (data.type) {
    validateExerciseType(data.type);
  }
  validateRepetitions(data.repetitions);

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.videoUrl !== undefined) updateData.videoUrl = data.videoUrl;
  if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
  if (data.sets !== undefined) updateData.sets = data.sets;
  if (data.repetitions !== undefined) updateData.repetitions = data.repetitions;
  if (data.duration !== undefined) updateData.duration = data.duration;
  if (data.hasLoad !== undefined) updateData.hasLoad = data.hasLoad;
  if (data.suggestedLoad !== undefined) updateData.suggestedLoad = data.suggestedLoad;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await prisma.exerciseTemplate.update({
    where: { id: templateId },
    data: updateData,
  });

  return updated;
}

/**
 * Soft delete an exercise template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Deleted template
 */
export async function deleteExerciseTemplate(userId, templateId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.exerciseTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  const deleted = await prisma.exerciseTemplate.update({
    where: { id: templateId },
    data: { deletedAt: new Date() },
  });

  return deleted;
}

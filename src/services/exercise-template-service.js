import { prisma } from '../db.js';
import { buildError, validateExerciseType } from '../helpers/training-validators.js';
import { exerciseTypeValues } from '../constants/training.js';
import {
  advancedTechniqueLinksInclude,
  replaceAdvancedTechniqueLinks,
  toLinkCreateInput,
  withAdvancedTechniqueRefs,
} from '../helpers/advanced-technique-refs.js';
import { assertVideoFileKeyAllowed } from '../helpers/exercise-video-key.js';
import { resolveAdvancedTechniqueSelection } from './advanced-technique-service.js';

// Library exercise templates carry only the exercise identity (name, type, video).
// Prescription ("how it's done": sets/reps/load/rest/intensity) lives where a workout
// has direction — the TrainingTemplateExerciseTemplate junction and the real Exercise.
function buildTemplateData(data, trainerId) {
  return {
    trainerId,
    name: data.name,
    type: data.type,
    videoUrl: data.videoUrl || null,
    gifUrl: data.gifUrl || null,
    videoFileKey: data.videoFileKey ?? null,
    isPublic: data.isPublic !== undefined ? data.isPublic : false,
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
  assertVideoFileKeyAllowed(trainer.id, data.videoFileKey);
  const techniqueSelection = await resolveAdvancedTechniqueSelection(prisma, trainer.id, data.advancedTechniqueIds);

  const created = await prisma.exerciseTemplate.create({
    data: {
      ...buildTemplateData(data, trainer.id),
      ...toLinkCreateInput(techniqueSelection),
    },
    include: advancedTechniqueLinksInclude,
  });

  return withAdvancedTechniqueRefs(created);
}

/**
 * Get exercise templates for a trainer (own + public) with pagination and search
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} filters - { page, limit, q, type }
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function getExerciseTemplatesByTrainer(userId, filters = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const page = Math.max(1, parseInt(filters.page ?? 1, 10));
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? 20, 10)));
  const skip = (page - 1) * limit;

  const where = {
    deletedAt: null,
    OR: [{ trainerId: trainer.id }, { isPublic: true }],
    ...(filters.q && { name: { contains: filters.q, mode: 'insensitive' } }),
    ...(filters.type && exerciseTypeValues.includes(filters.type) && { type: filters.type }),
  };

  const [data, total] = await Promise.all([
    prisma.exerciseTemplate.findMany({
      where,
      include: advancedTechniqueLinksInclude,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.exerciseTemplate.count({ where }),
  ]);

  return { data: data.map((template) => withAdvancedTechniqueRefs(template, trainer.id)), total, page, limit };
}

/**
 * Batch soft-delete exercise templates owned by the trainer.
 * Non-owned or already-deleted IDs are silently skipped.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string[]} ids - Array of template IDs to delete
 * @returns {Promise<{ deletedCount: number }>}
 */
export async function batchDeleteExerciseTemplates(userId, ids) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const { count } = await prisma.exerciseTemplate.updateMany({
    where: {
      id: { in: ids },
      trainerId: trainer.id,
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });

  return { deletedCount: count };
}

/**
 * Get public exercise templates only, hiding other trainers' private techniques
 *
 * @param {string} userId - User ID of the requesting trainer
 * @returns {Promise<object[]>} List of public templates
 */
export async function getPublicExerciseTemplates(userId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const templates = await prisma.exerciseTemplate.findMany({
    where: { isPublic: true, deletedAt: null },
    include: {
      ...advancedTechniqueLinksInclude,
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

  return templates.map((template) => withAdvancedTechniqueRefs(template, trainer.id));
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
      ...advancedTechniqueLinksInclude,
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

  return withAdvancedTechniqueRefs(template, trainer.id);
}

// Updates a template and replaces its technique links atomically.
function updateTemplateWithTechniques(templateId, updateData, techniqueSelection) {
  return prisma.$transaction(async (tx) => {
    await replaceAdvancedTechniqueLinks(
      tx.exerciseTemplateAdvancedTechnique,
      'exerciseTemplateId',
      templateId,
      techniqueSelection,
    );
    return tx.exerciseTemplate.update({
      where: { id: templateId },
      data: updateData,
      include: advancedTechniqueLinksInclude,
    });
  });
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
  assertVideoFileKeyAllowed(trainer.id, data.videoFileKey, [template.videoFileKey]);

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.videoUrl !== undefined) updateData.videoUrl = data.videoUrl;
  if (data.gifUrl !== undefined) updateData.gifUrl = data.gifUrl;
  if (data.videoFileKey !== undefined) updateData.videoFileKey = data.videoFileKey;
  if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;

  const techniqueSelection = data.advancedTechniqueIds === undefined
    ? undefined
    : await resolveAdvancedTechniqueSelection(prisma, trainer.id, data.advancedTechniqueIds);

  const updated = techniqueSelection
    ? await updateTemplateWithTechniques(templateId, updateData, techniqueSelection)
    : await prisma.exerciseTemplate.update({
      where: { id: templateId },
      data: updateData,
      include: advancedTechniqueLinksInclude,
    });

  return withAdvancedTechniqueRefs(updated);
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

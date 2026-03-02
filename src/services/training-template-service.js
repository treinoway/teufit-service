import { prisma } from '../db.js';
import { buildError, validateCategory, validateBodySegment } from '../helpers/training-validators.js';

const exerciseTemplatesInclude = {
  trainingTemplateExerciseTemplates: {
    orderBy: { order: 'asc' },
    include: {
      exerciseTemplate: true,
    },
  },
};

/**
 * Create a new training template
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Template data (optional exerciseTemplates: [{ exerciseTemplateId, order? }])
 * @returns {Promise<object>} Created template
 */
export async function createTrainingTemplate(userId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Validate category
  validateCategory(data.category);

  // 3. Validate body segment if provided
  if (data.bodySegment) {
    validateBodySegment(data.bodySegment);
  }

  // 4. Normalize exercise templates: accept exerciseTemplateIds (array of uuid) or exerciseTemplates (array of { exerciseTemplateId, order? })
  const rawList = Array.isArray(data.exerciseTemplateIds)
    ? data.exerciseTemplateIds.map((id) => ({ exerciseTemplateId: id }))
    : data.exerciseTemplates || [];
  const exerciseTemplatesInput = Array.isArray(rawList) ? rawList : [];

  if (exerciseTemplatesInput.length > 0) {
    const ids = [...new Set(exerciseTemplatesInput.map((e) => e.exerciseTemplateId))];
    const existing = await prisma.exerciseTemplate.findMany({
      where: { id: { in: ids }, trainerId: trainer.id, deletedAt: null },
      select: { id: true },
    });
    const foundIds = new Set(existing.map((e) => e.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw buildError(
        'EXERCISE_TEMPLATE_NOT_FOUND',
        `Exercise template(s) not found or not owned by trainer: ${missing.join(', ')}`,
        404,
      );
    }
  }

  // 5. Build create data (omit trainingTemplateExerciseTemplates when empty so Prisma does not receive undefined)
  const createData = {
    trainerId: trainer.id,
    name: data.name,
    description: data.description || null,
    category: data.category,
    bodySegment: data.bodySegment || null,
    tags: data.tags || [],
    isPublic: data.isPublic !== undefined ? data.isPublic : false,
  };
  if (exerciseTemplatesInput.length > 0) {
    createData.trainingTemplateExerciseTemplates = {
      create: exerciseTemplatesInput.map((e, index) => ({
        exerciseTemplateId: e.exerciseTemplateId,
        order: e.order !== undefined ? e.order : index,
      })),
    };
  }

  const template = await prisma.trainingTemplate.create({
    data: createData,
    include: exerciseTemplatesInclude,
  });

  return template;
}

/**
 * Get training templates created by a trainer (includes public templates)
 *
 * @param {string} userId - User ID of the trainer
 * @returns {Promise<object[]>} List of templates
 */
export async function getTrainingTemplatesByTrainer(userId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Fetch templates (own templates + public templates from others)
  const templates = await prisma.trainingTemplate.findMany({
    where: {
      deletedAt: null,
      OR: [
        { trainerId: trainer.id }, // Own templates
        { isPublic: true }, // Public templates
      ],
    },
    include: {
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      ...exerciseTemplatesInclude,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return templates;
}

/**
 * Get public training templates only
 *
 * @returns {Promise<object[]>} List of public templates
 */
export async function getPublicTrainingTemplates() {
  const templates = await prisma.trainingTemplate.findMany({
    where: {
      isPublic: true,
      deletedAt: null,
    },
    include: {
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      ...exerciseTemplatesInclude,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return templates;
}

/**
 * Get a single training template by ID
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Template
 */
export async function getTrainingTemplateById(userId, templateId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Fetch template
  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
    include: {
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      ...exerciseTemplatesInclude,
    },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  // 3. Verify access (own template or public)
  if (template.trainerId !== trainer.id && !template.isPublic) {
    throw buildError('FORBIDDEN_PRIVATE_TEMPLATE', 'This template is private', 403);
  }

  return template;
}

/**
 * Update a training template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated template
 */
export async function updateTrainingTemplate(userId, templateId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify template exists and ownership
  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  // Only owner can edit (even if public)
  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
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
  if (data.tags !== undefined) updateData.tags = data.tags;
  if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;

  // 6. If exercise templates provided (exerciseTemplateIds or exerciseTemplates), validate and prepare relation update
  const hasExerciseTemplatesUpdate =
    data.exerciseTemplateIds !== undefined || data.exerciseTemplates !== undefined;
  if (hasExerciseTemplatesUpdate) {
    const rawList = Array.isArray(data.exerciseTemplateIds)
      ? data.exerciseTemplateIds.map((id) => ({ exerciseTemplateId: id }))
      : data.exerciseTemplates || [];
    const exerciseTemplatesInput = Array.isArray(rawList) ? rawList : [];
    if (exerciseTemplatesInput.length > 0) {
      const ids = [...new Set(exerciseTemplatesInput.map((e) => e.exerciseTemplateId))];
      const existing = await prisma.exerciseTemplate.findMany({
        where: { id: { in: ids }, trainerId: trainer.id, deletedAt: null },
        select: { id: true },
      });
      const foundIds = new Set(existing.map((e) => e.id));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw buildError(
          'EXERCISE_TEMPLATE_NOT_FOUND',
          `Exercise template(s) not found or not owned by trainer: ${missing.join(', ')}`,
          404,
        );
      }
    }
    updateData.trainingTemplateExerciseTemplates = {
      deleteMany: {},
      create: exerciseTemplatesInput.map((e, index) => ({
        exerciseTemplateId: e.exerciseTemplateId,
        order: e.order !== undefined ? e.order : index,
      })),
    };
  }

  // 7. Update template
  const updated = await prisma.trainingTemplate.update({
    where: { id: templateId },
    data: updateData,
    include: exerciseTemplatesInclude,
  });

  return updated;
}

/**
 * Soft delete a training template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Deleted template
 */
export async function deleteTrainingTemplate(userId, templateId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify template exists and ownership
  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  // 3. Soft delete
  const deleted = await prisma.trainingTemplate.update({
    where: { id: templateId },
    data: {
      deletedAt: new Date(),
    },
  });

  return deleted;
}

import { prisma } from '../db.js';
import { buildError, validateCategory, validateBodySegment } from '../helpers/training-validators.js';

/**
 * Create a new training template
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Template data
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

  // 4. Create template
  const template = await prisma.trainingTemplate.create({
    data: {
      trainerId: trainer.id,
      name: data.name,
      description: data.description || null,
      category: data.category,
      bodySegment: data.bodySegment || null,
      tags: data.tags || [],
      isPublic: data.isPublic !== undefined ? data.isPublic : false,
    },
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

  // 6. Update template
  const updated = await prisma.trainingTemplate.update({
    where: { id: templateId },
    data: updateData,
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

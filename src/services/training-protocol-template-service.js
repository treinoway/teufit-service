import { prisma } from '../db.js';
import { buildError, validateWeekDays, validateGenderOrdination, validateTrainingLevel } from '../helpers/training-validators.js';

/**
 * Create a new protocol template (TRAINER only)
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Template data
 * @param {string} data.name - Template name
 * @param {string} [data.description] - Template description
 * @param {string[]} [data.availableWeekDays] - Available week days
 * @param {number} [data.defaultDurationWeeks] - Default duration in weeks
 * @returns {Promise<object>} Created template
 */
export async function createProtocolTemplate(userId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Validate week days if provided
  if (data.availableWeekDays && data.availableWeekDays.length > 0) {
    validateWeekDays(data.availableWeekDays, 'availableWeekDays');
  }

  // 3. Validate new enum fields if provided
  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);

  // 4. Create template
  const template = await prisma.trainingProtocolTemplate.create({
    data: {
      trainerId: trainer.id,
      name: data.name,
      description: data.description || null,
      availableWeekDays: data.availableWeekDays || [],
      defaultDurationWeeks: data.defaultDurationWeeks || null,
      genderOrdination: data.genderOrdination || null,
      trainingLevel: data.trainingLevel || null,
    },
  });

  return template;
}

/**
 * Get all protocol templates created by a trainer
 *
 * @param {string} userId - User ID of the trainer
 * @returns {Promise<object[]>} List of templates
 */
export async function getProtocolTemplatesByTrainer(userId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Fetch templates
  const templates = await prisma.trainingProtocolTemplate.findMany({
    where: {
      trainerId: trainer.id,
      deletedAt: null,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return templates;
}

/**
 * Get a single protocol template by ID
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Template
 */
export async function getProtocolTemplateById(userId, templateId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Fetch template
  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  // 3. Verify ownership
  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  return template;
}

/**
 * Update a protocol template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated template
 */
export async function updateProtocolTemplate(userId, templateId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify template exists and ownership
  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  // 3. Validate week days if provided
  if (data.availableWeekDays && data.availableWeekDays.length > 0) {
    validateWeekDays(data.availableWeekDays, 'availableWeekDays');
  }

  // 4. Validate new enum fields if provided
  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);

  // 5. Build update data (only include provided fields)
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.availableWeekDays !== undefined) updateData.availableWeekDays = data.availableWeekDays;
  if (data.defaultDurationWeeks !== undefined) updateData.defaultDurationWeeks = data.defaultDurationWeeks;
  if (data.genderOrdination !== undefined) updateData.genderOrdination = data.genderOrdination;
  if (data.trainingLevel !== undefined) updateData.trainingLevel = data.trainingLevel;

  // 6. Update template
  const updated = await prisma.trainingProtocolTemplate.update({
    where: { id: templateId },
    data: updateData,
  });

  return updated;
}

/**
 * Soft delete a protocol template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Deleted template
 */
export async function deleteProtocolTemplate(userId, templateId) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify template exists and ownership
  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  // 3. Soft delete
  const deleted = await prisma.trainingProtocolTemplate.update({
    where: { id: templateId },
    data: {
      deletedAt: new Date(),
    },
  });

  return deleted;
}

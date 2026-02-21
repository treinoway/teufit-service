import { prisma } from '../db.js';
import { buildError, validateWeekDays, validateGenderOrdination, validateTrainingLevel } from '../helpers/training-validators.js';

/**
 * Validate that each training item in the trainings array is accessible by the trainer
 * (either owned by the trainer or marked as public) and that weekDay is valid.
 */
async function validateAndResolveTrainings(trainings, trainerId, availableWeekDays) {
  if (!Array.isArray(trainings) || trainings.length === 0) return;

  const ids = trainings.map((t) => t.trainingTemplateId);
  const templates = await prisma.trainingTemplate.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, trainerId: true, isPublic: true },
  });

  const templateMap = new Map(templates.map((t) => [t.id, t]));

  for (const item of trainings) {
    const tpl = templateMap.get(item.trainingTemplateId);
    if (!tpl) {
      throw buildError(
        'TRAINING_TEMPLATE_NOT_FOUND',
        `Training template not found: ${item.trainingTemplateId}`,
        404,
      );
    }

    if (tpl.trainerId !== trainerId && !tpl.isPublic) {
      throw buildError(
        'FORBIDDEN_TRAINING_TEMPLATE_ACCESS',
        `You do not have access to training template: ${item.trainingTemplateId}`,
        403,
      );
    }

    if (availableWeekDays && availableWeekDays.length > 0 && !availableWeekDays.includes(item.weekDay)) {
      throw buildError(
        'INVALID_WEEK_DAY_FOR_SCHEDULE',
        `Week day "${item.weekDay}" is not in the template's availableWeekDays`,
        400,
      );
    }
  }
}

/**
 * Create a new protocol template (TRAINER only)
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Template data
 * @param {string} data.name - Template name
 * @param {string} [data.description] - Template description
 * @param {string[]} [data.availableWeekDays] - Available week days
 * @param {number} [data.defaultDurationWeeks] - Default duration in weeks
 * @param {object[]} [data.trainings] - Schedule template entries
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

  // 4. Validate trainings if provided
  if (data.trainings && data.trainings.length > 0) {
    await validateAndResolveTrainings(data.trainings, trainer.id, data.availableWeekDays || []);
  }

  // 5. Create template and schedule templates in a transaction
  const template = await prisma.$transaction(async (tx) => {
    const created = await tx.trainingProtocolTemplate.create({
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

    if (data.trainings && data.trainings.length > 0) {
      await tx.trainingScheduleTemplate.createMany({
        data: data.trainings.map((item) => ({
          protocolTemplateId: created.id,
          trainingTemplateId: item.trainingTemplateId,
          weekDay: item.weekDay,
          order: item.order ?? 0,
        })),
      });
    }

    return tx.trainingProtocolTemplate.findUnique({
      where: { id: created.id },
      include: {
        scheduleTemplates: {
          include: {
            trainingTemplate: {
              select: { id: true, name: true, category: true, bodySegment: true },
            },
          },
          orderBy: [{ weekDay: 'asc' }, { order: 'asc' }],
        },
      },
    });
  });

  return { ...template, scheduleTemplatesCount: template.scheduleTemplates.length };
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
    include: {
      _count: {
        select: { scheduleTemplates: true },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return templates.map(({ _count, ...tpl }) => ({
    ...tpl,
    scheduleTemplatesCount: _count.scheduleTemplates,
  }));
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

  // 2. Fetch template with schedule templates
  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
    include: {
      scheduleTemplates: {
        include: {
          trainingTemplate: {
            select: { id: true, name: true, category: true, bodySegment: true },
          },
        },
        orderBy: [{ weekDay: 'asc' }, { order: 'asc' }],
      },
    },
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
 * @param {object[]} [data.trainings] - Replacement schedule template entries (replaces all existing)
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

  // 5. Validate trainings if provided
  const effectiveWeekDays = data.availableWeekDays ?? template.availableWeekDays;
  if (data.trainings !== undefined) {
    await validateAndResolveTrainings(data.trainings, trainer.id, effectiveWeekDays);
  }

  // 6. Build update data (only include provided fields)
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.availableWeekDays !== undefined) updateData.availableWeekDays = data.availableWeekDays;
  if (data.defaultDurationWeeks !== undefined) updateData.defaultDurationWeeks = data.defaultDurationWeeks;
  if (data.genderOrdination !== undefined) updateData.genderOrdination = data.genderOrdination;
  if (data.trainingLevel !== undefined) updateData.trainingLevel = data.trainingLevel;

  // 7. Update template and optionally replace schedule templates in a transaction
  const updated = await prisma.$transaction(async (tx) => {
    await tx.trainingProtocolTemplate.update({
      where: { id: templateId },
      data: updateData,
    });

    if (data.trainings !== undefined) {
      await tx.trainingScheduleTemplate.deleteMany({
        where: { protocolTemplateId: templateId },
      });

      if (data.trainings.length > 0) {
        await tx.trainingScheduleTemplate.createMany({
          data: data.trainings.map((item) => ({
            protocolTemplateId: templateId,
            trainingTemplateId: item.trainingTemplateId,
            weekDay: item.weekDay,
            order: item.order ?? 0,
          })),
        });
      }
    }

    return tx.trainingProtocolTemplate.findUnique({
      where: { id: templateId },
      include: {
        scheduleTemplates: {
          include: {
            trainingTemplate: {
              select: { id: true, name: true, category: true, bodySegment: true },
            },
          },
          orderBy: [{ weekDay: 'asc' }, { order: 'asc' }],
        },
      },
    });
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

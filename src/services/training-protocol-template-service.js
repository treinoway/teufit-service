import { prisma } from '../db.js';
import { buildError, validateWeekDay, validateGenderOrdination, validateTrainingLevel, validateProtocolType } from '../helpers/training-validators.js';
import { maybeMarkFirstProtocolCreated } from './trainer-onboarding-service.js';
import { protocolTypeValues, trainingLevelValues, ExerciseOrderBy } from '../constants/training.js';

/**
 * Shared Prisma include for a protocol template's trainings relation. Hydrates
 * each `ProtocolTemplateTraining` with its full `TrainingTemplate` row plus the
 * junction rows that wire it to the trainer's exercise templates — without
 * these nested relations the builder UI can't re-render a saved training.
 */
const protocolTemplateTrainingsInclude = {
  trainings: {
    orderBy: { order: 'asc' },
    include: {
      trainingTemplate: {
        include: {
          trainingTemplateExerciseTemplates: {
            orderBy: ExerciseOrderBy,
            include: { exerciseTemplate: true },
          },
        },
      },
    },
  },
};

/**
 * Validate that each training item in the trainings array is accessible by the trainer
 * (either owned by the trainer or marked as public).
 */
async function validateAndResolveTrainings(trainings, trainerId) {
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

    if (item.weekDay) {
      validateWeekDay(item.weekDay, 'weekDay');
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
 * @param {number} [data.defaultDurationWeeks] - Default duration in weeks
 * @param {object[]} [data.trainings] - Protocol template training entries
 * @returns {Promise<object>} Created template
 */
export async function createProtocolTemplate(userId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);
  validateProtocolType(data.type);

  if (data.trainings && data.trainings.length > 0) {
    await validateAndResolveTrainings(data.trainings, trainer.id);
  }

  const template = await prisma.$transaction(async (tx) => {
    const created = await tx.trainingProtocolTemplate.create({
      data: {
        trainerId: trainer.id,
        name: data.name,
        description: data.description || null,
        defaultDurationWeeks: data.defaultDurationWeeks || null,
        genderOrdination: data.genderOrdination || null,
        trainingLevel: data.trainingLevel || null,
        type: data.type || null,
      },
    });

    if (data.trainings && data.trainings.length > 0) {
      await tx.protocolTemplateTraining.createMany({
        data: data.trainings.map((item) => ({
          protocolTemplateId: created.id,
          trainingTemplateId: item.trainingTemplateId,
          weekDay: item.weekDay || null,
          order: item.order ?? 0,
        })),
      });
    }

    return tx.trainingProtocolTemplate.findUnique({
      where: { id: created.id },
      include: protocolTemplateTrainingsInclude,
    });
  });

  await maybeMarkFirstProtocolCreated({ trainerId: trainer.id });

  return { ...template, trainingsCount: template.trainings.length };
}

/**
 * Get all protocol templates created by a trainer with pagination and search
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} filters - { page, limit, q, type, trainingLevel }
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function getProtocolTemplatesByTrainer(userId, filters = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const page = Math.max(1, parseInt(filters.page ?? 1, 10));
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? 20, 10)));
  const skip = (page - 1) * limit;

  const where = {
    trainerId: trainer.id,
    deletedAt: null,
    ...(filters.q && { name: { contains: filters.q, mode: 'insensitive' } }),
    ...(filters.type && protocolTypeValues.includes(filters.type) && { type: filters.type }),
    ...(filters.trainingLevel && trainingLevelValues.includes(filters.trainingLevel) && { trainingLevel: filters.trainingLevel }),
  };

  const [templates, total] = await Promise.all([
    prisma.trainingProtocolTemplate.findMany({
      where,
      include: {
        _count: {
          select: { trainings: true },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    }),
    prisma.trainingProtocolTemplate.count({ where }),
  ]);

  const data = templates.map(({ _count, ...tpl }) => ({
    ...tpl,
    trainingsCount: _count.trainings,
  }));

  return { data, total, page, limit };
}

/**
 * Batch soft-delete protocol templates owned by the trainer.
 * Non-owned or already-deleted IDs are silently skipped.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string[]} ids - Array of template IDs to delete
 * @returns {Promise<{ deletedCount: number }>}
 */
export async function batchDeleteProtocolTemplates(userId, ids) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const { count } = await prisma.trainingProtocolTemplate.updateMany({
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
 * Get a single protocol template by ID
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @returns {Promise<object>} Template
 */
export async function getProtocolTemplateById(userId, templateId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
    include: protocolTemplateTrainingsInclude,
  });

  if (!template) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  return template;
}

// Editing the example routine turns its linked example trainings into normal ones.
async function clearExampleOnLinkedTrainings(tx, protocolTemplateId) {
  await tx.trainingTemplate.updateMany({
    where: { isExample: true, protocolTemplateTrainings: { some: { protocolTemplateId } } },
    data: { isExample: false },
  });
}

/**
 * Update a protocol template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @param {object} data - Update data
 * @param {object[]} [data.trainings] - Replacement training entries (replaces all existing)
 * @returns {Promise<object>} Updated template
 */
export async function updateProtocolTemplate(userId, templateId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);
  validateProtocolType(data.type);

  if (data.trainings !== undefined) {
    await validateAndResolveTrainings(data.trainings, trainer.id);
  }

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.defaultDurationWeeks !== undefined) updateData.defaultDurationWeeks = data.defaultDurationWeeks;
  if (data.genderOrdination !== undefined) updateData.genderOrdination = data.genderOrdination;
  if (data.trainingLevel !== undefined) updateData.trainingLevel = data.trainingLevel;
  if (data.type !== undefined) updateData.type = data.type;

  if (template.isExample) updateData.isExample = false;

  const updated = await prisma.$transaction(async (tx) => {
    if (template.isExample) await clearExampleOnLinkedTrainings(tx, templateId);

    await tx.trainingProtocolTemplate.update({
      where: { id: templateId },
      data: updateData,
    });

    if (data.trainings !== undefined) {
      await tx.protocolTemplateTraining.deleteMany({
        where: { protocolTemplateId: templateId },
      });

      if (data.trainings.length > 0) {
        await tx.protocolTemplateTraining.createMany({
          data: data.trainings.map((item) => ({
            protocolTemplateId: templateId,
            trainingTemplateId: item.trainingTemplateId,
            weekDay: item.weekDay || null,
            order: item.order ?? 0,
          })),
        });
      }
    }

    return tx.trainingProtocolTemplate.findUnique({
      where: { id: templateId },
      include: protocolTemplateTrainingsInclude,
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
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  const deleted = await prisma.trainingProtocolTemplate.update({
    where: { id: templateId },
    data: {
      deletedAt: new Date(),
    },
  });

  return deleted;
}

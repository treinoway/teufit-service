import { prisma } from '../db.js';
import {
  buildError,
  validateCategory,
  validateBodySegment,
  validateExerciseType,
  validateRepetitions,
  validatePrescriptionMode,
  applyPrescriptionModeExclusivity,
  resolvePrescriptionMode,
} from '../helpers/training-validators.js';
import { PrescriptionMode } from '../constants/training.js';

/**
 * Build junction row create/update data by merging caller overrides with template snapshot.
 * The input `e` may carry optional override fields (e.g. `{ sets: 5 }`).
 * Fields not provided by the caller fall back to the fetched template values.
 *
 * @param {object} e - Input item (exerciseTemplateId, order?, and any snapshot overrides)
 * @param {number} index - Fallback order when e.order is not set
 * @param {object} template - Full ExerciseTemplate row fetched from DB
 * @returns {object} Junction row create data
 */
function buildJunctionCreateData(e, index, template) {
  const resolvedMode = e.prescriptionMode !== undefined
    ? e.prescriptionMode
    : resolvePrescriptionMode(template.prescriptionMode, template);

  const baseRepetitions = e.repetitions !== undefined ? e.repetitions : template.repetitions;
  const baseDuration = e.duration !== undefined ? e.duration : template.duration;
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, {
    repetitions: baseRepetitions,
    duration: baseDuration,
  });

  return {
    exerciseTemplateId: e.exerciseTemplateId,
    order: e.order !== undefined ? e.order : index,
    // Bi-set / superset grouping — passed through from caller input (C3)
    supersetGroupId: e.supersetGroupId !== undefined ? e.supersetGroupId : null,
    supersetOrder: e.supersetOrder !== undefined ? e.supersetOrder : 0,
    name: e.name !== undefined ? e.name : template.name,
    type: e.type !== undefined ? e.type : template.type,
    videoUrl: e.videoUrl !== undefined ? e.videoUrl : template.videoUrl,
    sets: e.sets !== undefined ? e.sets : template.sets,
    repetitions,
    duration,
    prescriptionMode: resolvedMode,
    hasLoad: e.hasLoad !== undefined ? e.hasLoad : template.hasLoad,
    suggestedLoad: e.suggestedLoad !== undefined ? e.suggestedLoad : template.suggestedLoad,
    restInterval: e.restInterval !== undefined ? e.restInterval : template.restInterval,
    notes: e.notes !== undefined ? e.notes : template.notes,
    intensity: e.intensity !== undefined ? e.intensity : template.intensity,
  };
}

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

  let existingTemplatesById = {};
  if (exerciseTemplatesInput.length > 0) {
    const ids = [...new Set(exerciseTemplatesInput.map((e) => e.exerciseTemplateId))];
    const existing = await prisma.exerciseTemplate.findMany({
      where: { id: { in: ids }, trainerId: trainer.id, deletedAt: null },
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
    // Index by id for O(1) lookup when building junction rows
    existingTemplatesById = Object.fromEntries(existing.map((t) => [t.id, t]));
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
      create: exerciseTemplatesInput.map((e, index) =>
        buildJunctionCreateData(e, index, existingTemplatesById[e.exerciseTemplateId]),
      ),
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
    let updateTemplatesById = {};
    if (exerciseTemplatesInput.length > 0) {
      const ids = [...new Set(exerciseTemplatesInput.map((e) => e.exerciseTemplateId))];
      const existing = await prisma.exerciseTemplate.findMany({
        where: { id: { in: ids }, trainerId: trainer.id, deletedAt: null },
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
      updateTemplatesById = Object.fromEntries(existing.map((t) => [t.id, t]));
    }
    updateData.trainingTemplateExerciseTemplates = {
      deleteMany: {},
      create: exerciseTemplatesInput.map((e, index) =>
        buildJunctionCreateData(e, index, updateTemplatesById[e.exerciseTemplateId]),
      ),
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

/**
 * Update a single exercise (junction row) inside a training template.
 * Only the snapshot fields on the junction row are changed — the global ExerciseTemplate is untouched.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Training template ID
 * @param {string} exerciseId - Junction row ID (TrainingTemplateExerciseTemplate.id)
 * @param {object} data - Fields to update (any combination of snapshot fields + order)
 * @returns {Promise<object>} Updated junction row (includes exerciseTemplate relation)
 */
export async function updateTrainingTemplateExercise(userId, templateId, exerciseId, data) {
  // 1. Verify trainer profile exists
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify training template exists, is owned by trainer, and is not deleted
  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  // 3. Find junction row by id, scoped to this training template
  const junctionRow = await prisma.trainingTemplateExerciseTemplate.findFirst({
    where: { id: exerciseId, trainingTemplateId: templateId },
  });

  if (!junctionRow) {
    throw buildError('TRAINING_TEMPLATE_EXERCISE_NOT_FOUND', 'Exercise not found in this training template', 404);
  }

  // 4. Build update data — only include fields explicitly provided by the caller
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.videoUrl !== undefined) updateData.videoUrl = data.videoUrl;
  if (data.sets !== undefined) updateData.sets = data.sets;
  if (data.hasLoad !== undefined) updateData.hasLoad = data.hasLoad;
  if (data.suggestedLoad !== undefined) updateData.suggestedLoad = data.suggestedLoad;
  if (data.restInterval !== undefined) updateData.restInterval = data.restInterval;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.supersetGroupId !== undefined) updateData.supersetGroupId = data.supersetGroupId;
  if (data.supersetOrder !== undefined) updateData.supersetOrder = data.supersetOrder;

  if (data.prescriptionMode !== undefined) {
    const { repetitions, duration } = applyPrescriptionModeExclusivity(data.prescriptionMode, data);
    updateData.prescriptionMode = data.prescriptionMode;
    updateData.repetitions = repetitions;
    updateData.duration = duration;
  } else {
    if (data.repetitions !== undefined) updateData.repetitions = data.repetitions;
    if (data.duration !== undefined) updateData.duration = data.duration;
  }

  // 5. Update and return the updated junction row with exerciseTemplate for reference
  const updated = await prisma.trainingTemplateExerciseTemplate.update({
    where: { id: exerciseId },
    data: updateData,
    include: { exerciseTemplate: true },
  });

  return updated;
}

/**
 * Ownership gate reused by every junction-row mutation. Returns the trainer when OK,
 * throws the appropriate AppError otherwise.
 */
async function assertTrainerOwnsTemplate(userId, templateId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.trainingTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Training template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  return { trainer, template };
}

/**
 * Returns the next `order` value for a junction row in the given training template.
 * Walks the whole relation to find max + 1 — safe because the row count stays small.
 */
async function nextExerciseOrder(templateId) {
  const last = await prisma.trainingTemplateExerciseTemplate.findFirst({
    where: { trainingTemplateId: templateId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  return last ? last.order + 1 : 0;
}

/**
 * Create a brand-new ExerciseTemplate and attach it to a training template via a junction row.
 * Runs inside a transaction so a failure halfway leaves no orphan rows.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Training template ID
 * @param {object} data - Exercise fields (name, type required) + optional order
 * @returns {Promise<object>} Created junction row (includes exerciseTemplate relation)
 */
export async function createTrainingTemplateExercise(userId, templateId, data) {
  const { trainer } = await assertTrainerOwnsTemplate(userId, templateId);

  validateExerciseType(data.type);
  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  const resolvedMode = data.prescriptionMode ?? PrescriptionMode.REPS;
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, data);
  const order = data.order !== undefined ? data.order : await nextExerciseOrder(templateId);

  const junction = await prisma.$transaction(async (tx) => {
    const exerciseTemplate = await tx.exerciseTemplate.create({
      data: {
        trainerId: trainer.id,
        name: data.name,
        type: data.type,
        videoUrl: data.videoUrl ?? null,
        isPublic: data.isPublic !== undefined ? data.isPublic : false,
        sets: data.sets ?? null,
        repetitions,
        duration,
        prescriptionMode: resolvedMode,
        hasLoad: data.hasLoad !== undefined ? data.hasLoad : false,
        suggestedLoad: data.suggestedLoad ?? null,
        restInterval: data.restInterval ?? null,
        notes: data.notes ?? null,
      },
    });

    return tx.trainingTemplateExerciseTemplate.create({
      data: {
        trainingTemplateId: templateId,
        exerciseTemplateId: exerciseTemplate.id,
        order,
        supersetGroupId: data.supersetGroupId ?? null,
        supersetOrder: data.supersetOrder ?? 0,
        name: exerciseTemplate.name,
        type: exerciseTemplate.type,
        videoUrl: exerciseTemplate.videoUrl,
        sets: exerciseTemplate.sets,
        repetitions: exerciseTemplate.repetitions,
        duration: exerciseTemplate.duration,
        prescriptionMode: exerciseTemplate.prescriptionMode,
        hasLoad: exerciseTemplate.hasLoad,
        suggestedLoad: exerciseTemplate.suggestedLoad,
        restInterval: exerciseTemplate.restInterval,
        notes: exerciseTemplate.notes,
      },
      include: { exerciseTemplate: true },
    });
  });

  return junction;
}

/**
 * Attach an existing ExerciseTemplate to a training template by creating a junction row.
 * The ExerciseTemplate snapshot is copied to the junction at link time.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Training template ID
 * @param {object} data - { exerciseTemplateId, order? }
 * @returns {Promise<object>} Created junction row (includes exerciseTemplate relation)
 */
export async function createTrainingTemplateExerciseFromTemplate(userId, templateId, data) {
  const { trainer } = await assertTrainerOwnsTemplate(userId, templateId);

  const exerciseTemplate = await prisma.exerciseTemplate.findUnique({
    where: { id: data.exerciseTemplateId },
  });

  if (!exerciseTemplate || exerciseTemplate.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  // Only the owner can link — public templates belong to another trainer's library.
  if (exerciseTemplate.trainerId !== trainer.id) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  const order = data.order !== undefined ? data.order : await nextExerciseOrder(templateId);
  const resolvedMode = resolvePrescriptionMode(exerciseTemplate.prescriptionMode, exerciseTemplate);
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, exerciseTemplate);

  const junction = await prisma.trainingTemplateExerciseTemplate.create({
    data: {
      trainingTemplateId: templateId,
      exerciseTemplateId: exerciseTemplate.id,
      order,
      supersetGroupId: data.supersetGroupId ?? null,
      supersetOrder: data.supersetOrder ?? 0,
      name: exerciseTemplate.name,
      type: exerciseTemplate.type,
      videoUrl: exerciseTemplate.videoUrl,
      sets: exerciseTemplate.sets,
      repetitions,
      duration,
      prescriptionMode: resolvedMode,
      hasLoad: exerciseTemplate.hasLoad,
      suggestedLoad: exerciseTemplate.suggestedLoad,
      restInterval: exerciseTemplate.restInterval,
      notes: exerciseTemplate.notes,
    },
    include: { exerciseTemplate: true },
  });

  return junction;
}

/**
 * Delete a junction row (unlinks an exercise from a training template). The underlying
 * ExerciseTemplate row in the library is left intact — removal from the template is a
 * relationship change, not a library cleanup.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Training template ID
 * @param {string} exerciseId - Junction row ID (TrainingTemplateExerciseTemplate.id)
 * @returns {Promise<object>} The deleted junction row
 */
export async function deleteTrainingTemplateExercise(userId, templateId, exerciseId) {
  await assertTrainerOwnsTemplate(userId, templateId);

  const junctionRow = await prisma.trainingTemplateExerciseTemplate.findFirst({
    where: { id: exerciseId, trainingTemplateId: templateId },
    include: { exerciseTemplate: true },
  });

  if (!junctionRow) {
    throw buildError('TRAINING_TEMPLATE_EXERCISE_NOT_FOUND', 'Exercise not found in this training template', 404);
  }

  await prisma.trainingTemplateExerciseTemplate.delete({
    where: { id: exerciseId },
  });

  return junctionRow;
}

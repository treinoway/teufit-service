import { prisma } from '../db.js';
import { withDeadlockRetry } from '../helpers/db-retry.js';
import { lockTrainingTemplateForUpdate } from '../helpers/row-locks.js';
import {
  buildError,
  validateCategory,
  validateBodySegment,
  validateExerciseType,
  validateRepetitions,
  validatePrescriptionMode,
  applyPrescriptionModeExclusivity,
} from '../helpers/training-validators.js';
import { PrescriptionMode, ExerciseOrderBy, trainingCategoryValues, bodySegmentValues } from '../constants/training.js';
import {
  advancedTechniqueLinksInclude,
  replaceAdvancedTechniqueLinks,
  toLinkCreateInput,
  withAdvancedTechniqueRefs,
  withJunctionTechniqueRefs,
} from '../helpers/advanced-technique-refs.js';
import {
  inheritSelectionBatch,
  resolveAdvancedTechniqueSelection,
  resolveAdvancedTechniqueSelectionBatch,
  resolveSelectionOrInherit,
} from './advanced-technique-service.js';

/**
 * Build junction row create data. Identity fields (name/type/videoUrl) fall back to the
 * library ExerciseTemplate; prescription ("how it's done") comes only from the caller input
 * `e` and defaults to null — the library template no longer carries prescription, so a
 * workout's direction is supplied when the exercise is added to the training template.
 *
 * @param {object} e - Input item (exerciseTemplateId, order?, identity + prescription fields)
 * @param {number} index - Fallback order when e.order is not set
 * @param {object} template - Library ExerciseTemplate row (name/type/videoUrl source)
 * @param {object[]} techniqueSelection - Ordered technique links ({ advancedTechniqueId, order })
 * @returns {object} Junction row create data
 */
function buildJunctionCreateData(e, index, template, techniqueSelection = []) {
  const resolvedMode = e.prescriptionMode ?? PrescriptionMode.REPS;
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, e);

  return {
    exerciseTemplateId: e.exerciseTemplateId,
    order: e.order !== undefined ? e.order : index,
    // Bi-set / superset grouping — passed through from caller input (C3)
    supersetGroupId: e.supersetGroupId !== undefined ? e.supersetGroupId : null,
    supersetOrder: e.supersetOrder !== undefined ? e.supersetOrder : 0,
    supersetRestInterval: e.supersetRestInterval ?? null,
    name: e.name !== undefined ? e.name : template.name,
    type: e.type !== undefined ? e.type : template.type,
    videoUrl: e.videoUrl !== undefined ? e.videoUrl : template.videoUrl,
    gifUrl: e.gifUrl !== undefined ? e.gifUrl : template.gifUrl,
    sets: e.sets ?? null,
    repetitions,
    duration,
    prescriptionMode: resolvedMode,
    hasLoad: e.hasLoad !== undefined ? e.hasLoad : false,
    suggestedLoad: e.suggestedLoad ?? null,
    restInterval: e.restInterval ?? null,
    notes: e.notes ?? null,
    intensity: e.intensity ?? null,
    ...toLinkCreateInput(techniqueSelection),
  };
}

const junctionInclude = {
  exerciseTemplate: true,
  ...advancedTechniqueLinksInclude,
};

const exerciseTemplatesInclude = {
  trainingTemplateExerciseTemplates: {
    orderBy: ExerciseOrderBy,
    include: junctionInclude,
  },
};

// Resolves each junction input's techniques: explicit ids win (validated), otherwise inherit the library template's.
async function resolveJunctionTechniqueSelections(trainerId, inputs, templatesById) {
  const explicit = await resolveAdvancedTechniqueSelectionBatch(
    prisma,
    trainerId,
    inputs.map((input) => input.advancedTechniqueIds),
  );
  const inherited = await inheritSelectionBatch(
    prisma,
    trainerId,
    inputs.map((input) => templatesById[input.exerciseTemplateId]?.advancedTechniqueLinks ?? []),
  );
  return inputs.map((input, index) => (input.advancedTechniqueIds === undefined ? inherited[index] : explicit[index]));
}

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
    // Allow own templates and public ones from other trainers (the library lists both).
    const existing = await prisma.exerciseTemplate.findMany({
      where: { id: { in: ids }, deletedAt: null, OR: [{ trainerId: trainer.id }, { isPublic: true }] },
      include: { advancedTechniqueLinks: true },
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
    const selections = await resolveJunctionTechniqueSelections(trainer.id, exerciseTemplatesInput, existingTemplatesById);
    createData.trainingTemplateExerciseTemplates = {
      create: exerciseTemplatesInput.map((e, index) =>
        buildJunctionCreateData(e, index, existingTemplatesById[e.exerciseTemplateId], selections[index]),
      ),
    };
  }

  const template = await prisma.trainingTemplate.create({
    data: createData,
    include: exerciseTemplatesInclude,
  });

  return withJunctionTechniqueRefs(template);
}

/**
 * Get training templates created by a trainer (includes public templates) with pagination and search
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} filters - { page, limit, q, category, bodySegment }
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function getTrainingTemplatesByTrainer(userId, filters = {}) {
  // 1. Verify trainer profile exists
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
    isExample: false,
    OR: [
      { trainerId: trainer.id },
      { isPublic: true },
    ],
    ...(filters.q && { name: { contains: filters.q, mode: 'insensitive' } }),
    ...(filters.category && trainingCategoryValues.includes(filters.category) && { category: filters.category }),
    ...(filters.bodySegment && bodySegmentValues.includes(filters.bodySegment) && { bodySegment: filters.bodySegment }),
  };

  // 2. Fetch templates (own templates + public templates from others)
  const [data, total] = await Promise.all([
    prisma.trainingTemplate.findMany({
      where,
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
      skip,
      take: limit,
    }),
    prisma.trainingTemplate.count({ where }),
  ]);

  return { data: data.map((template) => withJunctionTechniqueRefs(template, trainer.id)), total, page, limit };
}

/**
 * Batch soft-delete training templates owned by the trainer.
 * Non-owned or already-deleted IDs are silently skipped.
 *
 * @param {string} userId - User ID of the trainer
 * @param {string[]} ids - Array of template IDs to delete
 * @returns {Promise<{ deletedCount: number }>}
 */
export async function batchDeleteTrainingTemplates(userId, ids) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const { count } = await prisma.trainingTemplate.updateMany({
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
 * Get public training templates only, hiding other trainers' private techniques
 *
 * @param {string} userId - User ID of the requesting trainer
 * @returns {Promise<object[]>} List of public templates
 */
export async function getPublicTrainingTemplates(userId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

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

  return templates.map((template) => withJunctionTechniqueRefs(template, trainer.id));
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

  return withJunctionTechniqueRefs(template, trainer.id);
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
        include: { advancedTechniqueLinks: true },
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
    const selections = await resolveJunctionTechniqueSelections(trainer.id, exerciseTemplatesInput, updateTemplatesById);
    updateData.trainingTemplateExerciseTemplates = {
      deleteMany: {},
      create: exerciseTemplatesInput.map((e, index) =>
        buildJunctionCreateData(e, index, updateTemplatesById[e.exerciseTemplateId], selections[index]),
      ),
    };
  }

  // 7. Update template
  const updated = await prisma.trainingTemplate.update({
    where: { id: templateId },
    data: updateData,
    include: exerciseTemplatesInclude,
  });

  return withJunctionTechniqueRefs(updated);
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

// Updates a junction row and replaces its technique links atomically.
function updateJunctionWithTechniques(junctionId, updateData, techniqueSelection) {
  return prisma.$transaction(async (tx) => {
    await replaceAdvancedTechniqueLinks(
      tx.trainingTemplateExerciseAdvancedTechnique,
      'trainingTemplateExerciseTemplateId',
      junctionId,
      techniqueSelection,
    );
    return tx.trainingTemplateExerciseTemplate.update({
      where: { id: junctionId },
      data: updateData,
      include: junctionInclude,
    });
  });
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
  if (data.gifUrl !== undefined) updateData.gifUrl = data.gifUrl;
  if (data.sets !== undefined) updateData.sets = data.sets;
  if (data.hasLoad !== undefined) updateData.hasLoad = data.hasLoad;
  if (data.suggestedLoad !== undefined) updateData.suggestedLoad = data.suggestedLoad;
  if (data.restInterval !== undefined) updateData.restInterval = data.restInterval;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.intensity !== undefined) updateData.intensity = data.intensity;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.supersetGroupId !== undefined) updateData.supersetGroupId = data.supersetGroupId;
  if (data.supersetOrder !== undefined) updateData.supersetOrder = data.supersetOrder;
  if (data.supersetRestInterval !== undefined) updateData.supersetRestInterval = data.supersetRestInterval;

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
  const techniqueSelection = data.advancedTechniqueIds === undefined
    ? undefined
    : await resolveAdvancedTechniqueSelection(prisma, trainer.id, data.advancedTechniqueIds);

  const updated = techniqueSelection
    ? await updateJunctionWithTechniques(exerciseId, updateData, techniqueSelection)
    : await prisma.trainingTemplateExerciseTemplate.update({
      where: { id: exerciseId },
      data: updateData,
      include: junctionInclude,
    });

  return withAdvancedTechniqueRefs(updated);
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

// Returns max junction order + 1 for the template; must run inside a tx holding the template lock.
async function nextExerciseOrder(tx, templateId) {
  const last = await tx.trainingTemplateExerciseTemplate.findFirst({
    where: { trainingTemplateId: templateId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  return last ? last.order + 1 : 0;
}

// Locks the training template, then returns the explicit order or max + 1 so concurrent appends serialize.
async function resolveJunctionOrder(tx, templateId, explicitOrder) {
  await lockTrainingTemplateForUpdate(tx, templateId);
  return explicitOrder !== undefined ? explicitOrder : nextExerciseOrder(tx, templateId);
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
  const techniqueSelection = await resolveAdvancedTechniqueSelection(prisma, trainer.id, data.advancedTechniqueIds);

  const junction = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const order = await resolveJunctionOrder(tx, templateId, data.order);
    // Library template holds identity only — prescription stays on the junction.
    const exerciseTemplate = await tx.exerciseTemplate.create({
      data: {
        trainerId: trainer.id,
        name: data.name,
        type: data.type,
        videoUrl: data.videoUrl ?? null,
        gifUrl: data.gifUrl ?? null,
        isPublic: data.isPublic !== undefined ? data.isPublic : false,
      },
    });

    return tx.trainingTemplateExerciseTemplate.create({
      data: {
        trainingTemplateId: templateId,
        exerciseTemplateId: exerciseTemplate.id,
        order,
        supersetGroupId: data.supersetGroupId ?? null,
        supersetOrder: data.supersetOrder ?? 0,
        supersetRestInterval: data.supersetRestInterval ?? null,
        name: exerciseTemplate.name,
        type: exerciseTemplate.type,
        videoUrl: exerciseTemplate.videoUrl,
        gifUrl: exerciseTemplate.gifUrl,
        sets: data.sets ?? null,
        repetitions,
        duration,
        prescriptionMode: resolvedMode,
        hasLoad: data.hasLoad !== undefined ? data.hasLoad : false,
        suggestedLoad: data.suggestedLoad ?? null,
        restInterval: data.restInterval ?? null,
        notes: data.notes ?? null,
        intensity: data.intensity ?? null,
        ...toLinkCreateInput(techniqueSelection),
      },
      include: junctionInclude,
    });
  }));

  return withAdvancedTechniqueRefs(junction);
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
    include: { advancedTechniqueLinks: true },
  });

  if (!exerciseTemplate || exerciseTemplate.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  // Own templates and public ones from other trainers can be linked (the library lists both).
  if (exerciseTemplate.trainerId !== trainer.id && !exerciseTemplate.isPublic) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  // Identity comes from the library template; prescription is set by the trainer at link
  // time (the workout's direction) — the library template no longer carries prescription.
  const resolvedMode = data.prescriptionMode ?? PrescriptionMode.REPS;
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, data);
  const techniqueSelection = await resolveSelectionOrInherit(
    prisma,
    trainer.id,
    data.advancedTechniqueIds,
    exerciseTemplate.advancedTechniqueLinks,
  );

  const junction = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const order = await resolveJunctionOrder(tx, templateId, data.order);
    return tx.trainingTemplateExerciseTemplate.create({
      data: {
        trainingTemplateId: templateId,
        exerciseTemplateId: exerciseTemplate.id,
        order,
        supersetGroupId: data.supersetGroupId ?? null,
        supersetOrder: data.supersetOrder ?? 0,
        supersetRestInterval: data.supersetRestInterval ?? null,
        name: exerciseTemplate.name,
        type: exerciseTemplate.type,
        videoUrl: exerciseTemplate.videoUrl,
        gifUrl: exerciseTemplate.gifUrl,
        sets: data.sets ?? null,
        repetitions,
        duration,
        prescriptionMode: resolvedMode,
        hasLoad: data.hasLoad !== undefined ? data.hasLoad : false,
        suggestedLoad: data.suggestedLoad ?? null,
        restInterval: data.restInterval ?? null,
        notes: data.notes ?? null,
        intensity: data.intensity ?? null,
        ...toLinkCreateInput(techniqueSelection),
      },
      include: junctionInclude,
    });
  }));

  return withAdvancedTechniqueRefs(junction);
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
    include: junctionInclude,
  });

  if (!junctionRow) {
    throw buildError('TRAINING_TEMPLATE_EXERCISE_NOT_FOUND', 'Exercise not found in this training template', 404);
  }

  await prisma.trainingTemplateExerciseTemplate.delete({
    where: { id: exerciseId },
  });

  return withAdvancedTechniqueRefs(junctionRow);
}

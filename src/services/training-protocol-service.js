import { prisma } from '../db.js';
import { TrainingStatus, trainingStatusValues, BulkProtocolErrorCode, BulkProtocolMessageCode } from '../constants/training.js';
import { buildError, validateGenderOrdination, validateTrainingLevel, validateProtocolType, resolvePrescriptionMode, applyPrescriptionModeExclusivity } from '../helpers/training-validators.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';
import { maybeMarkFirstProtocolCreated } from './trainer-onboarding-service.js';
import { markBriefingDirty } from './briefing-service.js';
import { assertStudentActiveOnPlan } from './platform-plan-service.js';
import { estimateWorkoutDuration } from '../helpers/workout-duration.js';
import { AppError } from '../errors/app-error.js';

/**
 * Validate status
 */
function validateStatus(status) {
  if (!trainingStatusValues.includes(status)) {
    throw buildError(
      'INVALID_STATUS',
      `Invalid status: ${status}. Valid values are: ${trainingStatusValues.join(', ')}`,
    );
  }
}

function normalizeProtocolDateFields(protocol) {
  if (!protocol) return protocol;

  const normalizedProtocol = { ...protocol };

  if (protocol.startDate !== undefined) {
    normalizedProtocol.startDate = formatDateOnly(protocol.startDate);
  }

  if (protocol.expirationDate !== undefined) {
    normalizedProtocol.expirationDate = formatDateOnly(protocol.expirationDate);
  }

  return normalizedProtocol;
}

/**
 * Create a new training protocol for a user (TRAINER only)
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} data - Protocol data
 * @returns {Promise<object>} Created protocol
 */
export async function createProtocol(userId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const assignee = await prisma.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildError('ASSIGNEE_NOT_FOUND', 'Assignee user not found', 404);
  }

  await assertStudentActiveOnPlan(prisma, trainer.id, data.assigneeId);

  if (data.status) {
    validateStatus(data.status);
  }

  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);
  validateProtocolType(data.type);

  const protocol = await prisma.trainingProtocol.create({
    data: {
      trainerId: trainer.id,
      assigneeId: data.assigneeId,
      protocolTemplateId: data.protocolTemplateId || null,
      name: data.name,
      description: data.description || null,
      status: data.status || 'active',
      startDate: parseDateOnlyAsUtc(data.startDate),
      expirationDate: parseDateOnlyAsUtc(data.expirationDate),
      genderOrdination: data.genderOrdination || null,
      trainingLevel: data.trainingLevel || null,
      type: data.type || null,
    },
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  });

  await maybeMarkFirstProtocolCreated({ trainerId: trainer.id });

  return normalizeProtocolDateFields(protocol);
}

/**
 * Get protocols created by a trainer
 *
 * @param {string} userId - User ID of the trainer
 * @param {object} filters - Optional filters
 * @param {string} [filters.status] - Filter by status
 * @param {string} [filters.assigneeId] - Filter by assignee user ID
 * @returns {Promise<object[]>} List of protocols
 */
export async function getProtocolsByTrainer(userId, filters = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const where = {
    trainerId: trainer.id,
    deletedAt: null,
  };

  if (filters.status) {
    validateStatus(filters.status);
    where.status = filters.status;
  }

  if (filters.assigneeId) {
    where.assigneeId = filters.assigneeId;
  }

  const protocols = await prisma.trainingProtocol.findMany({
    where,
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
      protocolTemplate: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return protocols.map(normalizeProtocolDateFields);
}

/**
 * Get protocols assigned to a user (assignee)
 *
 * @param {string} userId - User ID of the assignee
 * @param {object} filters - Optional filters
 * @param {string} [filters.status] - Filter by status
 * @returns {Promise<object[]>} List of protocols
 */
export async function getMyProtocols(userId, filters = {}) {
  const where = {
    assigneeId: userId,
    deletedAt: null,
  };

  if (filters.status) {
    validateStatus(filters.status);
    where.status = filters.status;
  } else {
    where.status = { in: ['active', 'completed'] };
  }

  const protocols = await prisma.trainingProtocol.findMany({
    where,
    include: {
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
      trainings: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
    orderBy: {
      startDate: 'desc',
    },
  });

  return protocols.map((protocol) => ({
    ...normalizeProtocolDateFields(protocol),
    trainer: protocol.trainer?.user || null,
  }));
}

/**
 * Get a single protocol by ID
 *
 * @param {string} userId - User ID
 * @param {string} protocolId - Protocol ID
 * @param {string} context - Context: 'trainer' or 'student'
 * @returns {Promise<object>} Protocol
 */
export async function getProtocolById(userId, protocolId, context) {
  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
      trainer: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
      protocolTemplate: {
        select: {
          id: true,
          name: true,
        },
      },
      trainings: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Protocol not found', 404);
  }

  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    if (protocol.trainerId !== trainer.id) {
      throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
    }
  } else if (context === 'assignee') {
    if (protocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_PROTOCOL', 'This protocol is not assigned to you', 403);
    }

    const { trainer, ...rest } = protocol;
    return {
      ...normalizeProtocolDateFields(rest),
      trainer: trainer?.user || null,
    };
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  return normalizeProtocolDateFields(protocol);
}

/**
 * Update a training protocol
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} protocolId - Protocol ID
 * @param {object} data - Update data
 * @returns {Promise<object>} Updated protocol
 */
export async function updateProtocol(userId, protocolId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Protocol not found', 404);
  }

  if (protocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
  }

  if (data.status) {
    validateStatus(data.status);
  }

  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);
  validateProtocolType(data.type);

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.startDate !== undefined) updateData.startDate = parseDateOnlyAsUtc(data.startDate);
  if (data.expirationDate !== undefined) {
    updateData.expirationDate = parseDateOnlyAsUtc(data.expirationDate);
  }
  if (data.genderOrdination !== undefined) updateData.genderOrdination = data.genderOrdination;
  if (data.trainingLevel !== undefined) updateData.trainingLevel = data.trainingLevel;
  if (data.type !== undefined) updateData.type = data.type;

  const updated = await prisma.trainingProtocol.update({
    where: { id: protocolId },
    data: updateData,
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  });

  // Status change (e.g. to archived) or date window change affects adherence KPIs
  const affectsBriefing =
    data.status !== undefined ||
    data.startDate !== undefined ||
    data.expirationDate !== undefined;
  if (affectsBriefing) {
    markBriefingDirty(prisma, updated.trainerId).catch((err) =>
      console.error('[briefing] Failed to mark dirty after protocol update:', err),
    );
  }

  return normalizeProtocolDateFields(updated);
}

/**
 * Soft delete a protocol
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} protocolId - Protocol ID
 * @returns {Promise<object>} Deleted protocol
 */
export async function deleteProtocol(userId, protocolId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const protocol = await prisma.trainingProtocol.findUnique({
    where: { id: protocolId },
  });

  if (!protocol || protocol.deletedAt) {
    throw buildError('PROTOCOL_NOT_FOUND', 'Protocol not found', 404);
  }

  if (protocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this protocol', 403);
  }

  if (protocol.status === TrainingStatus.ACTIVE) {
    throw buildError(
      'PROTOCOL_STATUS_NOT_DELETABLE',
      'Active protocols cannot be deleted. Archive the protocol first.',
      409,
    );
  }

  const deleted = await prisma.trainingProtocol.update({
    where: { id: protocolId },
    data: {
      deletedAt: new Date(),
    },
  });

  return normalizeProtocolDateFields(deleted);
}

/**
 * Create a protocol from a template
 *
 * @param {string} userId - User ID of the trainer
 * @param {string} templateId - Template ID
 * @param {string} assigneeId - User ID of the assignee
 * @param {object} data - Additional protocol data
 * @returns {Promise<object>} Created protocol
 */
export async function importFromTemplate(userId, templateId, assigneeId, data = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const template = await prisma.trainingProtocolTemplate.findUnique({
    where: { id: templateId },
    include: {
      trainings: {
        include: {
          trainingTemplate: {
            include: {
              trainingTemplateExerciseTemplates: {
                include: {
                  exerciseTemplate: true,
                },
                orderBy: { order: 'asc' },
              },
            },
          },
        },
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!template || template.deletedAt) {
    throw buildError('TEMPLATE_NOT_FOUND', 'Protocol template not found', 404);
  }

  if (template.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_TEMPLATE_OWNER', 'You do not own this template', 403);
  }

  const assignee = await prisma.user.findUnique({
    where: { id: assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildError('ASSIGNEE_NOT_FOUND', 'Assignee user not found', 404);
  }

  await assertStudentActiveOnPlan(prisma, trainer.id, assigneeId);

  const trainingsData = template.trainings.map((templateTraining) => {
    const { trainingTemplate } = templateTraining;
    const exerciseCreateData = trainingTemplate.trainingTemplateExerciseTemplates.map(
      (exercise, index) => buildNestedExerciseCreateData(exercise, index),
    );
    const estimatedDurationSeconds = estimateWorkoutDuration({ exercises: exerciseCreateData });

    return {
      trainingTemplateId: trainingTemplate.id,
      name: trainingTemplate.name,
      description: trainingTemplate.description,
      category: trainingTemplate.category,
      bodySegment: trainingTemplate.bodySegment,
      weekDay: templateTraining.weekDay || null,
      order: templateTraining.order,
      estimatedDurationSeconds,
      exercises: { create: exerciseCreateData },
    };
  });

  const created = await prisma.trainingProtocol.create({
    data: {
      trainerId: trainer.id,
      assigneeId,
      protocolTemplateId: template.id,
      name: data.name || template.name,
      description: data.description || template.description,
      status: 'active',
      startDate: data.startDate ? parseDateOnlyAsUtc(data.startDate) : new Date(),
      expirationDate: parseDateOnlyAsUtc(data.expirationDate),
      genderOrdination: data.genderOrdination ?? template.genderOrdination ?? null,
      trainingLevel: data.trainingLevel ?? template.trainingLevel ?? null,
      type: data.type !== undefined ? data.type : template.type,
      trainings: { create: trainingsData },
    },
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
      trainings: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  });
  const protocol = created;

  await maybeMarkFirstProtocolCreated({ trainerId: trainer.id });

  return normalizeProtocolDateFields(protocol);
}

// ─── Shared exercise helper ───────────────────────────────────────────────────

/**
 * Build a single exercise's nested-create data for a protocol/training write.
 * Applies prescriptionMode exclusivity so repetitions and duration are mutually exclusive.
 *
 * Used by both importFromTemplate and createProtocolWithTrainings so that any
 * new exercise field only needs to be added here.
 */
function buildNestedExerciseCreateData(exercise, index) {
  const resolvedMode = resolvePrescriptionMode(exercise.prescriptionMode, exercise);
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, exercise);

  return {
    exerciseTemplateId: exercise.exerciseTemplateId ?? null,
    name: exercise.name,
    type: exercise.type,
    videoUrl: exercise.videoUrl ?? null,
    // Fall back to array position when the client omits `order`; otherwise every
    // exercise inherits Prisma's @default(0) and the training is created with a
    // duplicated/zeroed order, which breaks execution ordering (orderBy order asc).
    order: exercise.order ?? index,
    sets: exercise.sets ?? null,
    repetitions,
    duration,
    prescriptionMode: resolvedMode,
    hasLoad: exercise.hasLoad ?? false,
    suggestedLoad: exercise.suggestedLoad ?? null,
    restInterval: exercise.restInterval ?? null,
    notes: exercise.notes ?? null,
    intensity: exercise.intensity ?? null,
  };
}

/**
 * Verify that all referenced trainingTemplateIds and exerciseTemplateIds are owned
 * by (or publicly accessible to) the trainer. Performs at most 2 batched queries.
 *
 * Throws TRAINING_TEMPLATE_NOT_OWNED or EXERCISE_TEMPLATE_NOT_OWNED if any FK
 * references a template that does not belong to the trainer and is not public.
 */
async function verifyTemplateOwnership(prismaClient, trainerId, trainingTemplateIds, exerciseTemplateIds) {
  if (trainingTemplateIds.size > 0) {
    const ownedTrainingTemplates = await prismaClient.trainingTemplate.findMany({
      where: {
        id: { in: [...trainingTemplateIds] },
        OR: [{ trainerId }, { isPublic: true }],
        deletedAt: null,
      },
      select: { id: true },
    });

    if (ownedTrainingTemplates.length !== trainingTemplateIds.size) {
      throw new AppError({
        httpStatus: 403,
        error: BulkProtocolErrorCode.TRAINING_TEMPLATE_NOT_OWNED,
        messageCode: BulkProtocolMessageCode.TRAINING_TEMPLATE_NOT_OWNED,
        message: 'One or more training templates do not belong to your profile.',
      });
    }
  }

  if (exerciseTemplateIds.size > 0) {
    const ownedExerciseTemplates = await prismaClient.exerciseTemplate.findMany({
      where: {
        id: { in: [...exerciseTemplateIds] },
        OR: [{ trainerId }, { isPublic: true }],
        deletedAt: null,
      },
      select: { id: true },
    });

    if (ownedExerciseTemplates.length !== exerciseTemplateIds.size) {
      throw new AppError({
        httpStatus: 403,
        error: BulkProtocolErrorCode.EXERCISE_TEMPLATE_NOT_OWNED,
        messageCode: BulkProtocolMessageCode.EXERCISE_TEMPLATE_NOT_OWNED,
        message: 'One or more exercise templates do not belong to your profile.',
      });
    }
  }
}

/**
 * Collect unique non-null trainingTemplateIds and exerciseTemplateIds from the
 * incoming trainings array so they can be verified in a single batched query each.
 */
function collectTemplateIds(trainings) {
  const trainingTemplateIds = new Set();
  const exerciseTemplateIds = new Set();

  for (const training of trainings) {
    if (training.trainingTemplateId) {
      trainingTemplateIds.add(training.trainingTemplateId);
    }
    for (const exercise of training.exercises ?? []) {
      if (exercise.exerciseTemplateId) {
        exerciseTemplateIds.add(exercise.exerciseTemplateId);
      }
    }
  }

  return { trainingTemplateIds, exerciseTemplateIds };
}

/**
 * Map an array of incoming training payloads to Prisma nested create shape.
 * Computes estimatedDurationSeconds in-memory — no extra DB queries.
 */
function buildTrainingsData(trainings) {
  return trainings.map((training) => {
    const exercises = training.exercises ?? [];
    const exerciseCreateData = exercises.map((exercise, index) =>
      buildNestedExerciseCreateData(exercise, index),
    );
    const estimatedDurationSeconds = estimateWorkoutDuration({ exercises: exerciseCreateData });

    return {
      trainingTemplateId: training.trainingTemplateId ?? null,
      name: training.name,
      description: training.description ?? null,
      category: training.category,
      bodySegment: training.bodySegment ?? null,
      weekDay: training.weekDay ?? null,
      order: training.order,
      estimatedDurationSeconds,
      exercises: { create: exerciseCreateData },
    };
  });
}

// ─── Public service function ──────────────────────────────────────────────────

/**
 * Create a training protocol together with all its trainings and exercises
 * in a single atomic nested write. Replaces the T×E sequential waterfall of
 * individual create calls from the frontend.
 *
 * Query budget:
 *   1. trainer.findUnique (resolve trainer.id)
 *   2. user.findUnique (verify assignee exists and is not deleted)
 *   3. assertStudentActiveOnPlan (1 query internal)
 *   4. trainingTemplate.findMany (ownership check — only when IDs are present)
 *   5. exerciseTemplate.findMany (ownership check — only when IDs are present)
 *   6. trainingProtocol.create with deep nested trainings + exercises (1 atomic write)
 *   Total: 3–6 queries regardless of training/exercise count.
 *
 * @param {string} userId - User ID of the authenticated trainer
 * @param {object} data - Protocol + trainings payload
 * @returns {Promise<object>} Created protocol with assignee and trainings
 */
export async function createProtocolWithTrainings(userId, data) {
  // 1. Resolve trainer profile
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  // 2. Verify assignee exists and is not soft-deleted
  const assignee = await prisma.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, deletedAt: true },
  });

  if (!assignee || assignee.deletedAt) {
    throw buildError('ASSIGNEE_NOT_FOUND', 'Assignee user not found', 404);
  }

  // 3. Guard: student must be active under trainer's plan
  await assertStudentActiveOnPlan(prisma, trainer.id, data.assigneeId);

  // 4. Validate protocol-level categorical fields
  if (data.status) {
    validateStatus(data.status);
  }
  validateGenderOrdination(data.genderOrdination);
  validateTrainingLevel(data.trainingLevel);
  validateProtocolType(data.type);

  // 5. Verify template ownership in 2 batched queries (skipped when no IDs are provided)
  const trainings = data.trainings ?? [];
  const { trainingTemplateIds, exerciseTemplateIds } = collectTemplateIds(trainings);
  await verifyTemplateOwnership(prisma, trainer.id, trainingTemplateIds, exerciseTemplateIds);

  // 6. Build in-memory nested create payload
  const trainingsData = buildTrainingsData(trainings);

  // 7. Single atomic write: protocol + all trainings + all exercises
  const created = await prisma.trainingProtocol.create({
    data: {
      trainerId: trainer.id,
      assigneeId: data.assigneeId,
      protocolTemplateId: data.protocolTemplateId ?? null,
      name: data.name,
      description: data.description ?? null,
      status: data.status ?? 'active',
      startDate: parseDateOnlyAsUtc(data.startDate),
      expirationDate: parseDateOnlyAsUtc(data.expirationDate),
      genderOrdination: data.genderOrdination ?? null,
      trainingLevel: data.trainingLevel ?? null,
      type: data.type ?? null,
      trainings: { create: trainingsData },
    },
    include: {
      assignee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
      trainings: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
      },
    },
  });

  // 8. Fire-and-forget onboarding milestone
  await maybeMarkFirstProtocolCreated({ trainerId: trainer.id });

  return normalizeProtocolDateFields(created);
}

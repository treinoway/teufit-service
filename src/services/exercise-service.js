import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import {
  buildError,
  validateExerciseType,
  validateRepetitions,
  validatePrescriptionMode,
  applyPrescriptionModeExclusivity,
  resolvePrescriptionMode,
  validateSubstituteConstraint,
  assertSupersetContiguity,
} from '../helpers/training-validators.js';
import {
  PrescriptionMode,
  SupersetConstraints,
  SupersetMessageCode,
  SubstituteMessageCode,
} from '../constants/training.js';
import { recomputeTrainingDuration } from '../helpers/workout-duration.js';
import { randomUUID } from 'crypto';

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Verify training ownership (trainer context)
 */
async function verifyTrainingOwnership(trainingId, trainerId) {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: { trainingProtocol: true },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.trainerId !== trainerId) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
  }

  return training;
}

/**
 * Load all active (non-deleted, non-substitute) exercises for a training, ordered by `order`.
 */
async function loadActiveExercises(trainingId) {
  return prisma.exercise.findMany({
    where: { trainingId, deletedAt: null },
    orderBy: { order: 'asc' },
  });
}


function buildExerciseData(data, trainingId, exerciseTemplateId = null) {
  const resolvedMode = data.prescriptionMode ?? PrescriptionMode.REPS;
  const { repetitions, duration } = applyPrescriptionModeExclusivity(resolvedMode, data);

  return {
    trainingId,
    exerciseTemplateId: exerciseTemplateId || null,
    name: data.name,
    type: data.type,
    videoUrl: data.videoUrl || null,
    order: data.order !== undefined ? data.order : 0,
    supersetGroupId: data.supersetGroupId ?? null,
    supersetOrder: data.supersetOrder ?? 0,
    substituteForExerciseId: data.substituteForExerciseId ?? null,
    substituteOrder: data.substituteOrder ?? 0,
    sets: data.sets ?? null,
    repetitions,
    duration,
    prescriptionMode: resolvedMode,
    hasLoad: data.hasLoad !== undefined ? data.hasLoad : false,
    suggestedLoad: data.suggestedLoad ?? null,
    restInterval: data.restInterval ?? null,
    notes: data.notes ?? null,
  };
}

function normalizeExercisePrescriptionMode(exercise) {
  if (!exercise) return exercise;
  return {
    ...exercise,
    prescriptionMode: resolvePrescriptionMode(exercise.prescriptionMode, exercise),
  };
}

/**
 * Normalize an exercise and its substitutes array.
 */
function normalizeExerciseWithSubstitutes(exercise) {
  if (!exercise) return exercise;
  const normalized = normalizeExercisePrescriptionMode(exercise);
  if (normalized.substitutes) {
    normalized.substitutes = normalized.substitutes.map(normalizeExercisePrescriptionMode);
  }
  return normalized;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new exercise within a training.
 *
 * If supersetGroupId is provided, validates that the group members will be
 * contiguous after this exercise is inserted.
 * If substituteForExerciseId is provided, validates substitute constraints.
 */
export async function createExercise(userId, trainingId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);
  validateExerciseType(data.type);
  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  // Substitutes are only added via POST /trainer/exercises/:id/substitutes — not via this endpoint.
  // createExerciseSchema strips substituteForExerciseId via additionalProperties: false.
  if (data.supersetGroupId) {
    // Resolve order and shift downstream exercises atomically so group stays contiguous
    const exercise = await createSupersetMemberAtomically(trainingId, data);
    return normalizeExercisePrescriptionMode(exercise);
  }

  const exercise = await prisma.$transaction(async (tx) => {
    const created = await tx.exercise.create({
      data: buildExerciseData(data, trainingId),
    });
    await recomputeTrainingDuration(tx, trainingId);
    return created;
  });

  return normalizeExercisePrescriptionMode(exercise);
}


/**
 * Create a superset member exercise atomically (M1).
 *
 * When `data.order` is omitted: auto-assigns order = max(group members) + 1 and shifts
 * downstream exercises by +1 so the new member lands at the end of the group.
 *
 * When `data.order` is explicitly provided: validates contiguity (the existing
 * validateNewSupersetMember logic), then creates with the given order. Callers are
 * responsible for ensuring the ordering is consistent; the auto-shift is NOT applied
 * for explicit orders to preserve intent.
 *
 * All queries and mutations run inside a single $transaction.
 */
async function createSupersetMemberAtomically(trainingId, data) {
  return prisma.$transaction(async (tx) => {
    const allActive = await tx.exercise.findMany({
      where: { trainingId, deletedAt: null },
      orderBy: { order: 'asc' },
    });

    const existingMembers = allActive.filter(
      (e) => e.supersetGroupId === data.supersetGroupId,
    );

    if (existingMembers.length >= SupersetConstraints.MAX_MEMBERS) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: SupersetMessageCode.MAX_MEMBERS,
        message: `A superset group cannot have more than ${SupersetConstraints.MAX_MEMBERS} members`,
      });
    }

    let resolvedOrder;

    if (data.order === undefined || data.order === null) {
      if (existingMembers.length === 0) {
        // First member — use end of training
        const maxExisting = allActive.length > 0
          ? Math.max(...allActive.map((e) => e.order))
          : -1;
        resolvedOrder = maxExisting + 1;
      } else {
        // Auto-assign after the last group member
        const maxGroupOrder = Math.max(...existingMembers.map((e) => e.order));
        resolvedOrder = maxGroupOrder + 1;

        // Shift all non-substitute exercises at or after this order up by 1
        await tx.exercise.updateMany({
          where: {
            trainingId,
            substituteForExerciseId: null,
            order: { gte: resolvedOrder },
          },
          data: { order: { increment: 1 } },
        });
      }
    } else {
      // Explicit order provided — validate contiguity (reject if it breaks the group)
      resolvedOrder = data.order;

      if (existingMembers.length > 0) {
        const orders = existingMembers.map((e) => e.order).sort((a, b) => a - b);
        const minOrder = orders[0];
        const maxOrder = orders[orders.length - 1];

        if (resolvedOrder < minOrder - 1 || resolvedOrder > maxOrder + 1) {
          throw new AppError({
            httpStatus: 400,
            error: 'VALIDATION_ERROR',
            messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
            message: 'The new superset member must be placed adjacent to the existing group members',
          });
        }

        const mockMembers = [
          ...existingMembers,
          { id: '__new__', order: resolvedOrder, substituteForExerciseId: null, trainingId },
        ];
        assertSupersetContiguity(mockMembers, allActive);
      }
    }

    const created = await tx.exercise.create({
      data: buildExerciseData({ ...data, order: resolvedOrder }, trainingId),
    });
    await recomputeTrainingDuration(tx, trainingId);
    return created;
  });
}

/**
 * Create an exercise from a template.
 */
export async function createFromTemplate(userId, trainingId, templateId, data = {}) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);

  const template = await prisma.exerciseTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || template.deletedAt) {
    throw buildError('EXERCISE_TEMPLATE_NOT_FOUND', 'Exercise template not found', 404);
  }

  if (template.trainerId !== trainer.id && !template.isPublic) {
    throw buildError('FORBIDDEN_PRIVATE_TEMPLATE', 'This template is private', 403);
  }

  const exerciseData = {
    name: data.name || template.name,
    type: data.type || template.type,
    videoUrl: data.videoUrl !== undefined ? data.videoUrl : template.videoUrl,
    order: data.order !== undefined ? data.order : 0,
    sets: data.sets !== undefined ? data.sets : template.sets,
    repetitions: data.repetitions !== undefined ? data.repetitions : template.repetitions,
    duration: data.duration !== undefined ? data.duration : template.duration,
    prescriptionMode: data.prescriptionMode !== undefined
      ? data.prescriptionMode
      : resolvePrescriptionMode(template.prescriptionMode, template),
    hasLoad: data.hasLoad !== undefined ? data.hasLoad : template.hasLoad,
    suggestedLoad: data.suggestedLoad !== undefined ? data.suggestedLoad : template.suggestedLoad,
    restInterval: data.restInterval !== undefined ? data.restInterval : template.restInterval,
    notes: data.notes !== undefined ? data.notes : template.notes,
  };

  const exercise = await prisma.$transaction(async (tx) => {
    const created = await tx.exercise.create({
      data: {
        ...buildExerciseData(exerciseData, trainingId, template.id),
        exerciseTemplateId: template.id,
      },
    });
    await recomputeTrainingDuration(tx, trainingId);
    return created;
  });

  return normalizeExercisePrescriptionMode(exercise);
}

/**
 * Get exercises by training.
 * Returns principals with nested substitutes[].
 */
export async function getExercisesByTraining(userId, trainingId, context) {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: { trainingProtocol: true },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    if (training.trainingProtocol.trainerId !== trainer.id) {
      throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
    }
  } else if (context === 'assignee') {
    if (training.trainingProtocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_TRAINING', 'This training is not assigned to you', 403);
    }
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  const principals = await prisma.exercise.findMany({
    where: { trainingId, deletedAt: null, substituteForExerciseId: null },
    include: {
      exerciseTemplate: { select: { id: true, name: true } },
      substitutes: {
        where: { deletedAt: null },
        orderBy: { substituteOrder: 'asc' },
        include: {
          exerciseTemplate: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { order: 'asc' },
  });

  return principals.map(normalizeExerciseWithSubstitutes);
}

/**
 * Get a single exercise by ID.
 */
export async function getExerciseById(userId, exerciseId, context) {
  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      training: { include: { trainingProtocol: true } },
      exerciseTemplate: { select: { id: true, name: true, type: true, videoUrl: true } },
      substitutes: {
        where: { deletedAt: null },
        orderBy: { substituteOrder: 'asc' },
        include: {
          exerciseTemplate: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!exercise || exercise.deletedAt || exercise.training?.deletedAt || exercise.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Exercise not found', 404);
  }

  const protocol = exercise.training.trainingProtocol;

  if (context === 'trainer') {
    const trainer = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!trainer) {
      throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
    }

    if (protocol.trainerId !== trainer.id) {
      throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
    }
  } else if (context === 'assignee') {
    if (protocol.assigneeId !== userId) {
      throw buildError('FORBIDDEN_NOT_YOUR_EXERCISE', 'This exercise is not assigned to you', 403);
    }
  } else {
    throw buildError('INVALID_CONTEXT', 'Context must be either "trainer" or "assignee"');
  }

  return normalizeExerciseWithSubstitutes(exercise);
}

/**
 * Update an exercise.
 *
 * Rejects an `order` change that would break superset contiguity.
 * Rejects changes to supersetGroupId/substituteForExerciseId after creation.
 */
export async function updateExercise(userId, exerciseId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      training: { include: { trainingProtocol: true } },
    },
  });

  if (!exercise || exercise.deletedAt || exercise.training?.deletedAt || exercise.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Exercise not found', 404);
  }

  if (exercise.training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
  }

  // Role-changing fields are fixed at creation; use dedicated endpoints to restructure.
  // This guard lives at the service layer — not just the schema — to prevent regressions.
  if (data.supersetGroupId !== undefined || data.substituteForExerciseId !== undefined) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'supersetGroupId and substituteForExerciseId cannot be changed after creation',
    });
  }

  if (data.type) {
    validateExerciseType(data.type);
  }
  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  // If order is being changed and the exercise belongs to a superset, verify contiguity
  if (data.order !== undefined && data.order !== exercise.order && exercise.supersetGroupId) {
    const allActive = await loadActiveExercises(exercise.trainingId);
    const currentGroupMembers = allActive.filter(
      (e) => e.supersetGroupId === exercise.supersetGroupId,
    );
    // Simulate the new position
    const simulatedMembers = currentGroupMembers.map((e) =>
      e.id === exerciseId ? { ...e, order: data.order } : e,
    );
    assertSupersetContiguity(simulatedMembers, allActive.map((e) =>
      e.id === exerciseId ? { ...e, order: data.order } : e,
    ));
  }

  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.videoUrl !== undefined) updateData.videoUrl = data.videoUrl;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.sets !== undefined) updateData.sets = data.sets;
  if (data.hasLoad !== undefined) updateData.hasLoad = data.hasLoad;
  if (data.suggestedLoad !== undefined) updateData.suggestedLoad = data.suggestedLoad;
  if (data.restInterval !== undefined) updateData.restInterval = data.restInterval;
  if (data.notes !== undefined) updateData.notes = data.notes;

  if (data.prescriptionMode !== undefined) {
    const { repetitions, duration } = applyPrescriptionModeExclusivity(data.prescriptionMode, data);
    updateData.prescriptionMode = data.prescriptionMode;
    updateData.repetitions = repetitions;
    updateData.duration = duration;
  } else {
    if (data.repetitions !== undefined) updateData.repetitions = data.repetitions;
    if (data.duration !== undefined) updateData.duration = data.duration;
  }

  const durationAffectingFields = ['sets', 'repetitions', 'duration', 'prescriptionMode', 'restInterval'];
  const shouldRecompute = durationAffectingFields.some((field) => data[field] !== undefined);

  const updated = await prisma.exercise.update({
    where: { id: exerciseId },
    data: updateData,
  });

  if (shouldRecompute) {
    await recomputeTrainingDuration(prisma, exercise.trainingId);
  }

  return normalizeExercisePrescriptionMode(updated);
}

/**
 * Reorder all exercises within a training atomically.
 * Rejects substitute IDs in the list.
 * Rejects reorders that would break any superset group's contiguity.
 */
export async function reorderExercisesInTraining(userId, trainingId, exerciseIds) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    select: {
      id: true,
      deletedAt: true,
      trainingProtocol: {
        select: { trainerId: true, deletedAt: true },
      },
      exercises: {
        where: { deletedAt: null },
        select: { id: true, name: true, substituteForExerciseId: true, supersetGroupId: true },
      },
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this training', 403);
  }

  const activeExercises = training.exercises;
  const principalExercises = activeExercises.filter((e) => !e.substituteForExerciseId);
  const principalIds = new Set(principalExercises.map((e) => e.id));

  // Reject if any substitute ID is included
  const substituteIds = activeExercises
    .filter((e) => Boolean(e.substituteForExerciseId))
    .map((e) => e.id);
  const substituteIdsInPayload = exerciseIds.filter((id) =>
    substituteIds.includes(id),
  );
  if (substituteIdsInPayload.length > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Substitute exercise IDs must not appear in the reorder list',
      details: { substituteIds: substituteIdsInPayload },
    });
  }

  const validationDetails = validateExerciseIdsForReorder(exerciseIds, principalIds);
  if (validationDetails) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Invalid exerciseIds for reorder',
      details: validationDetails,
    });
  }

  // Build a map of proposed new orders
  const proposedOrderMap = new Map(exerciseIds.map((id, index) => [id, index]));

  // Check that no superset group is broken by the new order
  const groupIds = [...new Set(
    activeExercises
      .filter((e) => Boolean(e.supersetGroupId))
      .map((e) => e.supersetGroupId),
  )];

  for (const groupId of groupIds) {
    const members = activeExercises.filter((e) => e.supersetGroupId === groupId);
    const memberOrders = members.map((e) => proposedOrderMap.get(e.id)).sort((a, b) => a - b);
    const minOrder = memberOrders[0];
    const maxOrder = memberOrders[memberOrders.length - 1];

    // Verify no non-member principal sits between min and max
    const intruders = exerciseIds
      .filter((id, idx) => {
        const isInRange = idx >= minOrder && idx <= maxOrder;
        const isMember = members.some((m) => m.id === id);
        return isInRange && !isMember;
      });

    if (intruders.length > 0) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
        message: 'The requested reorder would break a superset group — all group members must remain contiguous',
        details: { supersetGroupId: groupId, intrudingExerciseIds: intruders },
      });
    }
  }

  const activeExerciseById = Object.fromEntries(principalExercises.map((e) => [e.id, e]));

  await prisma.$transaction((tx) =>
    Promise.all(
      exerciseIds.map((id, index) =>
        tx.exercise.update({
          where: { id },
          data: { order: index },
        }),
      ),
    ),
  );

  return {
    trainingId,
    exercises: exerciseIds.map((id, index) => ({
      id,
      name: activeExerciseById[id].name,
      order: index,
    })),
  };
}

function validateExerciseIdsForReorder(exerciseIds, principalIds) {
  if (!exerciseIds || exerciseIds.length === 0) {
    return { reason: 'exerciseIds must be a non-empty array' };
  }

  const seen = new Set();
  const duplicates = [];
  for (const id of exerciseIds) {
    if (seen.has(id)) {
      duplicates.push(id);
    }
    seen.add(id);
  }
  if (duplicates.length > 0) {
    return { reason: 'duplicate IDs', duplicates };
  }

  const unknownIds = exerciseIds.filter((id) => !principalIds.has(id));
  if (unknownIds.length > 0) {
    return { reason: 'unknown or soft-deleted exercise IDs', unknownIds };
  }

  if (exerciseIds.length !== principalIds.size) {
    return {
      reason: 'length mismatch',
      expected: principalIds.size,
      received: exerciseIds.length,
    };
  }

  return null;
}

/**
 * Soft delete an exercise.
 * - If principal: also soft-delete all substitutes.
 * - If superset member: after delete, clear group if < MIN_MEMBERS remain.
 */
export async function deleteExercise(userId, exerciseId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      training: { include: { trainingProtocol: true } },
    },
  });

  if (!exercise || exercise.deletedAt || exercise.training?.deletedAt || exercise.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Exercise not found', 404);
  }

  if (exercise.training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // Soft-delete the exercise itself
    await tx.exercise.update({
      where: { id: exerciseId },
      data: { deletedAt: now },
    });

    // If it's a principal, soft-delete all its substitutes
    if (exercise.substituteForExerciseId === null) {
      await tx.exercise.updateMany({
        where: { substituteForExerciseId: exerciseId, deletedAt: null },
        data: { deletedAt: now },
      });
    }

    // If the exercise was a superset member, check if the group is now undersized.
    // Running inside the transaction prevents a partial state where the invariant is violated.
    if (exercise.supersetGroupId) {
      // Fetch only as many rows as the threshold — we need to know if count < MIN_MEMBERS
      const remainingMembers = await tx.exercise.findMany({
        where: { trainingId: exercise.trainingId, supersetGroupId: exercise.supersetGroupId, deletedAt: null },
        select: { id: true },
        take: SupersetConstraints.MIN_MEMBERS,
      });

      if (remainingMembers.length < SupersetConstraints.MIN_MEMBERS) {
        await tx.exercise.updateMany({
          where: { trainingId: exercise.trainingId, supersetGroupId: exercise.supersetGroupId, deletedAt: null },
          data: { supersetGroupId: null, supersetOrder: 0 },
        });
      }
    }

    // Recompute duration only when a principal was deleted (substitutes have no contribution)
    if (exercise.substituteForExerciseId === null) {
      await recomputeTrainingDuration(tx, exercise.trainingId);
    }
  });

  return exercise;
}

// ─── Add substitute ──────────────────────────────────────────────────────────

/**
 * Add a substitute exercise under a principal.
 * Assigns the next substituteOrder automatically.
 *
 * @param {string} userId - Trainer user ID
 * @param {string} principalId - Principal exercise ID
 * @param {object} data - Exercise fields (name, type required)
 * @returns {Promise<object>} Created substitute Exercise
 */
export async function addSubstitute(userId, principalId, data) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const principal = await prisma.exercise.findUnique({
    where: { id: principalId },
    include: { training: { include: { trainingProtocol: true } } },
  });

  if (!principal || principal.deletedAt || principal.training?.deletedAt || principal.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Principal exercise not found', 404);
  }

  if (principal.training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
  }

  validateExerciseType(data.type);
  validatePrescriptionMode(data.prescriptionMode, data);
  validateRepetitions(data.repetitions);

  // The substitute schema blocks supersetGroupId, so the candidate always has null here.
  validateSubstituteConstraint(principal, {
    trainingId: principal.trainingId,
    supersetGroupId: null,
    substituteForExerciseId: null,
  });

  // substituteOrder lookup + create in one transaction — prevents two concurrent adds
  // from computing the same substituteOrder value (race condition).
  const substitute = await prisma.$transaction(async (tx) => {
    const lastSubstitute = await tx.exercise.findFirst({
      where: { substituteForExerciseId: principalId, deletedAt: null },
      orderBy: { substituteOrder: 'desc' },
      select: { substituteOrder: true },
    });
    const nextSubstituteOrder = lastSubstitute ? lastSubstitute.substituteOrder + 1 : 0;

    const substituteData = buildExerciseData(
      { ...data, substituteForExerciseId: principalId, substituteOrder: nextSubstituteOrder },
      principal.trainingId,
    );

    return tx.exercise.create({ data: substituteData });
  });

  return normalizeExercisePrescriptionMode(substitute);
}

// ─── Reorder substitutes ─────────────────────────────────────────────────────

/**
 * Reorder substitutes for a principal exercise.
 *
 * @param {string} userId - Trainer user ID
 * @param {string} principalId - Principal exercise ID
 * @param {string[]} substituteIds - All substitute IDs in the desired order
 * @returns {Promise<object[]>} Updated substitutes in new order
 */
export async function reorderSubstitutes(userId, principalId, substituteIds) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const principal = await prisma.exercise.findUnique({
    where: { id: principalId },
    include: { training: { include: { trainingProtocol: true } } },
  });

  if (!principal || principal.deletedAt || principal.training?.deletedAt || principal.training?.trainingProtocol?.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Principal exercise not found', 404);
  }

  if (principal.training.trainingProtocol.trainerId !== trainer.id) {
    throw buildError('FORBIDDEN_NOT_PROTOCOL_OWNER', 'You do not own this exercise', 403);
  }

  const activeSubstitutes = await prisma.exercise.findMany({
    where: { substituteForExerciseId: principalId, deletedAt: null },
    select: { id: true, name: true },
  });

  const activeSubstituteIds = new Set(activeSubstitutes.map((e) => e.id));

  if (substituteIds.length !== activeSubstitutes.length) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'substituteIds must contain all active substitutes',
      details: {
        expected: activeSubstitutes.length,
        received: substituteIds.length,
      },
    });
  }

  const unknownIds = substituteIds.filter((id) => !activeSubstituteIds.has(id));
  if (unknownIds.length > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Unknown or deleted substitute IDs',
      details: { unknownIds },
    });
  }

  const substituteById = Object.fromEntries(activeSubstitutes.map((e) => [e.id, e]));

  await prisma.$transaction((tx) =>
    Promise.all(
      substituteIds.map((id, index) =>
        tx.exercise.update({
          where: { id },
          data: { substituteOrder: index },
        }),
      ),
    ),
  );

  return substituteIds.map((id, index) => ({
    id,
    name: substituteById[id].name,
    substituteOrder: index,
  }));
}

// ─── Reorder superset members ────────────────────────────────────────────────

/**
 * Reorder exercises within a superset group (updates supersetOrder only).
 * Does not change the main `order` field.
 *
 * @param {string} userId - Trainer user ID
 * @param {string} trainingId - Training ID
 * @param {string} supersetGroupId - Superset group UUID
 * @param {string[]} exerciseIds - All member IDs in the desired superset order
 * @returns {Promise<object[]>} Updated members with new supersetOrder
 */
export async function reorderSupersetMembers(userId, trainingId, supersetGroupId, exerciseIds) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);

  const members = await prisma.exercise.findMany({
    where: { trainingId, supersetGroupId, deletedAt: null },
    select: { id: true, name: true },
  });

  if (members.length === 0) {
    throw new AppError({
      httpStatus: 404,
      error: 'SUPERSET_GROUP_NOT_FOUND',
      messageCode: SubstituteMessageCode.NOT_FOUND,
      message: 'Superset group not found or has no active members',
    });
  }

  const memberIds = new Set(members.map((e) => e.id));

  if (exerciseIds.length !== members.length) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'exerciseIds must contain all active superset members',
      details: { expected: members.length, received: exerciseIds.length },
    });
  }

  const unknownIds = exerciseIds.filter((id) => !memberIds.has(id));
  if (unknownIds.length > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'Unknown superset member IDs',
      details: { unknownIds },
    });
  }

  const memberById = Object.fromEntries(members.map((e) => [e.id, e]));

  await prisma.$transaction((tx) =>
    Promise.all(
      exerciseIds.map((id, index) =>
        tx.exercise.update({
          where: { id },
          data: { supersetOrder: index },
        }),
      ),
    ),
  );

  return exerciseIds.map((id, index) => ({
    id,
    name: memberById[id].name,
    supersetOrder: index,
  }));
}

// ─── Create superset ─────────────────────────────────────────────────────────

/**
 * Atomically group existing exercises into a new superset (bi-set).
 *
 * The array order defines both supersetOrder (0-based) and the training-level
 * order: members are made contiguous starting at the minimum current order of
 * any selected exercise. Non-member exercises that occupy positions inside that
 * target block are shifted upward to make room.
 *
 * @param {string} userId - Trainer user ID
 * @param {string} trainingId - Training ID (from URL param)
 * @param {string[]} exerciseIds - Ordered list of 2–6 principal exercise IDs
 * @returns {Promise<{ supersetGroupId, trainingId, members }>}
 */
export async function createSuperset(userId, trainingId, exerciseIds) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);

  if (!exerciseIds || exerciseIds.length < SupersetConstraints.MIN_MEMBERS) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SupersetMessageCode.MIN_MEMBERS,
      message: `A superset group requires at least ${SupersetConstraints.MIN_MEMBERS} members`,
    });
  }

  if (exerciseIds.length > SupersetConstraints.MAX_MEMBERS) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SupersetMessageCode.MAX_MEMBERS,
      message: `A superset group cannot have more than ${SupersetConstraints.MAX_MEMBERS} members`,
    });
  }

  const supersetGroupId = randomUUID();

  const updatedMembers = await prisma.$transaction(async (tx) => {
    const allActive = await tx.exercise.findMany({
      where: { trainingId, deletedAt: null },
      orderBy: { order: 'asc' },
    });

    // Validate each exercise ID exists in this training and is a principal
    const memberMap = new Map();
    for (const id of exerciseIds) {
      const exercise = allActive.find((e) => e.id === id);
      if (!exercise) {
        throw new AppError({
          httpStatus: 404,
          error: 'EXERCISE_NOT_FOUND',
          messageCode: 'resource.notFound',
          message: `Exercise ${id} not found in training`,
        });
      }
      if (exercise.substituteForExerciseId !== null) {
        throw new AppError({
          httpStatus: 400,
          error: 'VALIDATION_ERROR',
          messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
          message: 'Substitute exercises cannot belong to a superset group',
        });
      }
      if (exercise.supersetGroupId !== null) {
        throw new AppError({
          httpStatus: 409,
          error: 'EXERCISE_ALREADY_IN_SUPERSET',
          messageCode: SupersetMessageCode.ALREADY_IN_SUPERSET,
          message: 'One or more exercises already belong to a superset group',
        });
      }
      memberMap.set(id, exercise);
    }

    // Determine the contiguous target block starting at the lowest current order
    // of any selected member. Members are placed at [blockStart, blockStart+N-1]
    // in the caller's array order. Non-member principals that currently sit inside
    // that range are shifted to start immediately after the block, preserving
    // their relative sequence.
    const memberIds = new Set(exerciseIds);
    const memberCurrentOrders = exerciseIds.map((id) => memberMap.get(id).order);
    const blockStart = Math.min(...memberCurrentOrders);
    const blockSize = exerciseIds.length;
    const blockEnd = blockStart + blockSize - 1;

    // Non-member principals at or after blockStart, in ascending order. Their
    // relative sequence is preserved but they are re-indexed starting at
    // blockEnd + 1 to make room for the contiguous member block.
    const nonMembersAtOrAfterBlock = allActive
      .filter((e) => !memberIds.has(e.id) && e.substituteForExerciseId === null && e.order >= blockStart)
      .sort((a, b) => a.order - b.order);

    // Pre-build ascending-index map for O(1) lookup inside the descending loop.
    const ascendingIndexById = new Map(nonMembersAtOrAfterBlock.map((e, i) => [e.id, i]));

    // Process in descending target-order to avoid transient collisions (higher
    // values written first so in-flight rows are never stomped by a later write).
    const sortedDescending = [...nonMembersAtOrAfterBlock].sort((a, b) => b.order - a.order);
    for (const ex of sortedDescending) {
      const targetOrder = blockEnd + 1 + ascendingIndexById.get(ex.id);
      if (targetOrder !== ex.order) {
        await tx.exercise.update({
          where: { id: ex.id },
          data: { order: targetOrder },
        });
      }
    }

    // Assign members their contiguous orders and superset fields
    const results = [];
    for (let i = 0; i < exerciseIds.length; i += 1) {
      const id = exerciseIds[i];
      const updated = await tx.exercise.update({
        where: { id },
        data: {
          supersetGroupId,
          supersetOrder: i,
          order: blockStart + i,
        },
        select: { id: true, name: true, order: true, supersetOrder: true },
      });
      results.push(updated);
    }

    return results;
  });

  return {
    supersetGroupId,
    trainingId,
    members: updatedMembers,
  };
}

// ─── Dissolve superset ───────────────────────────────────────────────────────

/**
 * Dissolve a superset group: members become standalone exercises retaining
 * their current `order`. No rearrangement is applied.
 *
 * @param {string} userId - Trainer user ID
 * @param {string} trainingId - Training ID (from URL param)
 * @param {string} groupId - Superset group UUID
 * @returns {Promise<{ supersetGroupId, trainingId, dissolvedCount }>}
 */
export async function dissolveSuperset(userId, trainingId, groupId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  await verifyTrainingOwnership(trainingId, trainer.id);

  const members = await prisma.exercise.findMany({
    where: { trainingId, supersetGroupId: groupId, deletedAt: null },
    select: { id: true },
  });

  if (members.length === 0) {
    throw new AppError({
      httpStatus: 404,
      error: 'SUPERSET_GROUP_NOT_FOUND',
      messageCode: SupersetMessageCode.GROUP_NOT_FOUND,
      message: 'Superset group not found or has no active members',
    });
  }

  await prisma.exercise.updateMany({
    where: { trainingId, supersetGroupId: groupId, deletedAt: null },
    data: { supersetGroupId: null, supersetOrder: 0 },
  });

  return {
    supersetGroupId: groupId,
    trainingId,
    dissolvedCount: members.length,
  };
}

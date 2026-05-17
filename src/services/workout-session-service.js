import { prisma } from '../db.js';
import { WorkoutSessionStatus, ExerciseLogStatus, SubstituteMessageCode } from '../constants/training.js';
import { buildError } from '../helpers/training-validators.js';
import { AppError } from '../errors/app-error.js';
import { awardWorkoutCompletionPoints } from './gamification-service.js';
import { markBriefingDirty } from './briefing-service.js';

// ─── Briefing invalidation helper ────────────────────────────────────────────

/**
 * Resolve the trainer's Trainer.id from a training ID, then mark the briefing dirty.
 * Fire-and-forget safe: errors are logged and swallowed — never fail the main operation.
 *
 * @param {string} trainingId
 */
async function invalidateBriefingForTraining(trainingId) {
  try {
    const training = await prisma.training.findUnique({
      where: { id: trainingId },
      select: { trainingProtocol: { select: { trainerId: true } } },
    });
    const trainerId = training?.trainingProtocol?.trainerId;
    if (trainerId) {
      await markBriefingDirty(prisma, trainerId);
    }
  } catch (err) {
    console.error('[briefing] Failed to mark briefing dirty after session write:', err);
  }
}

// ─── Denormalization hooks (TrainerStudent hot-path fields) ──────────────────
// These keep TrainerStudent.lastWorkoutAt / currentPrLoad / currentPrAt fresh
// so the students list endpoint can serve them without aggregation queries.
// Both helpers are fire-and-forget; errors must never fail the main op.

/**
 * Update lastWorkoutAt for all TrainerStudent rows referencing this student,
 * only when the new finishedAt is strictly greater than the stored value
 * (prevents an older edit from overwriting a fresher signal).
 */
async function bumpLastWorkoutAt(studentId, finishedAt) {
  try {
    await prisma.trainerStudent.updateMany({
      where: {
        studentId,
        OR: [{ lastWorkoutAt: null }, { lastWorkoutAt: { lt: finishedAt } }],
      },
      data: { lastWorkoutAt: finishedAt },
    });
  } catch (err) {
    console.error('[denorm] Failed to bump lastWorkoutAt:', err);
  }
}

/**
 * Conditionally promote currentPrLoad/currentPrAt if `load` strictly exceeds
 * the stored PR. Failed sets (completed=false) are not eligible for PR.
 */
async function maybePromotePr(studentId, load, completed) {
  if (load == null) return;
  if (completed === false) return;
  try {
    await prisma.trainerStudent.updateMany({
      where: {
        studentId,
        OR: [{ currentPrLoad: null }, { currentPrLoad: { lt: load } }],
      },
      data: { currentPrLoad: load, currentPrAt: new Date() },
    });
  } catch (err) {
    console.error('[denorm] Failed to promote PR:', err);
  }
}

// ─── Shared selects ──────────────────────────────────────────────────────────

/**
 * The exercise select used in all session-detail queries.
 * Includes substitutes[] so the student app can render swap options without an extra fetch.
 */
const exerciseSelectWithSubstitutes = {
  select: {
    id: true,
    name: true,
    type: true,
    sets: true,
    repetitions: true,
    duration: true,
    prescriptionMode: true,
    hasLoad: true,
    suggestedLoad: true,
    restInterval: true,
    videoUrl: true,
    notes: true,
    substitutes: {
      where: { deletedAt: null },
      orderBy: { substituteOrder: 'asc' },
      select: { id: true, name: true, type: true, substituteOrder: true },
    },
  },
};

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Load a training that belongs to the given user (as protocol assignee).
 * Throws if not found, soft-deleted, or not assigned to the user.
 */
async function resolveAssigneeTraining(trainingId, userId) {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    include: {
      trainingProtocol: { select: { id: true, assigneeId: true, deletedAt: true } },
      exercises: {
        // Only principals — substitutes are logged on-demand when the student swaps
        where: { deletedAt: null, substituteForExerciseId: null },
        select: { id: true, order: true },
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!training || training.deletedAt || training.trainingProtocol?.deletedAt) {
    throw buildError('TRAINING_NOT_FOUND', 'Training not found', 404);
  }

  if (training.trainingProtocol.assigneeId !== userId) {
    throw buildError('FORBIDDEN_NOT_YOUR_TRAINING', 'This training is not assigned to you', 403);
  }

  return training;
}

/**
 * Load a workout session that belongs to the given user.
 * Throws if not found, soft-deleted, or not owned by the user.
 */
async function resolveUserSession(sessionId, userId) {
  const session = await prisma.workoutSession.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.deletedAt) {
    throw buildError('WORKOUT_SESSION_NOT_FOUND', 'Workout session not found', 404);
  }

  if (session.userId !== userId) {
    throw buildError('FORBIDDEN_NOT_YOUR_SESSION', 'This session does not belong to you', 403);
  }

  return session;
}

/**
 * Resolve an ExerciseLog that belongs to a given session and is accessible by
 * the session owner. Verifies ownership chain: exerciseLog → session → user.
 */
async function resolveExerciseLog(exerciseLogId, sessionId, userId) {
  const exerciseLog = await prisma.exerciseLog.findUnique({
    where: { id: exerciseLogId },
    include: { workoutSession: true },
  });

  if (!exerciseLog) {
    throw buildError('EXERCISE_LOG_NOT_FOUND', 'Exercise log not found', 404);
  }

  if (exerciseLog.workoutSessionId !== sessionId) {
    throw buildError('EXERCISE_LOG_NOT_IN_SESSION', 'Exercise log does not belong to this session', 404);
  }

  if (exerciseLog.workoutSession.userId !== userId) {
    throw buildError('FORBIDDEN_NOT_YOUR_SESSION', 'This session does not belong to you', 403);
  }

  return exerciseLog;
}

/**
 * Resolve a SetLog that belongs to a given exercise log.
 */
async function resolveSetLog(setLogId, exerciseLogId) {
  const setLog = await prisma.setLog.findUnique({
    where: { id: setLogId },
  });

  if (!setLog) {
    throw buildError('SET_LOG_NOT_FOUND', 'Set log not found', 404);
  }

  if (setLog.exerciseLogId !== exerciseLogId) {
    throw buildError('SET_LOG_NOT_IN_EXERCISE_LOG', 'Set log does not belong to this exercise log', 404);
  }

  return setLog;
}

/**
 * Verify that the trainer owns the student-trainer relationship.
 * Exported so the student-dashboard-service can reuse it.
 */
export async function resolveTrainerStudent(trainerId, studentId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId: trainerId },
    select: { id: true },
  });

  if (!trainer) {
    throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  }

  const relationship = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
  });

  if (!relationship) {
    throw buildError('STUDENT_NOT_FOUND', 'Student not found or not assigned to you', 404);
  }

  return trainer;
}

// ─── Student operations ───────────────────────────────────────────────────────

/**
 * Start a new workout session for a training.
 * Enforces one-active-session-per-user rule.
 * Auto-creates one ExerciseLog per exercise in the training (in a transaction).
 *
 * @param {string} userId
 * @param {string} trainingId
 * @param {object} data - Optional { notes }
 * @returns {Promise<object>} Created WorkoutSession with exerciseLogs
 */
export async function startSession(userId, trainingId, data = null) {
  const { notes } = data ?? {};
  const training = await resolveAssigneeTraining(trainingId, userId);

  const activeSession = await prisma.workoutSession.findFirst({
    where: {
      userId,
      status: WorkoutSessionStatus.IN_PROGRESS,
      deletedAt: null,
    },
    select: { id: true },
  });

  if (activeSession) {
    throw new AppError({
      httpStatus: 409,
      error: 'SESSION_ALREADY_IN_PROGRESS',
      messageCode: 'workoutSession.alreadyInProgress',
      message: 'You already have an active workout session in progress',
      details: { activeSessionId: activeSession.id },
    });
  }

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.workoutSession.create({
      data: {
        trainingId,
        userId,
        status: WorkoutSessionStatus.IN_PROGRESS,
        notes: notes ?? null,
      },
    });

    if (training.exercises.length > 0) {
      await tx.exerciseLog.createMany({
        data: training.exercises.map((exercise) => ({
          workoutSessionId: created.id,
          exerciseId: exercise.id,
          status: ExerciseLogStatus.PENDING,
          order: exercise.order,
        })),
      });
    }

    return tx.workoutSession.findUnique({
      where: { id: created.id },
      include: {
        training: { select: { id: true, name: true, category: true, estimatedDurationSeconds: true } },
        exerciseLogs: {
          orderBy: { order: 'asc' },
          include: {
            exercise: exerciseSelectWithSubstitutes,
            setLogs: { orderBy: { setNumber: 'asc' } },
          },
        },
      },
    });
  });

  // Starting a session changes the adherence denominator — mark dirty after tx
  invalidateBriefingForTraining(trainingId).catch(() => {});

  return session;
}

/**
 * List workout sessions for the authenticated user.
 *
 * @param {string} userId
 * @param {object} filters - { trainingId, status, dateFrom, dateTo, page, limit }
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function listSessions(userId, filters = {}) {
  const { trainingId, status, dateFrom, dateTo } = filters;
  const page = Math.max(1, parseInt(filters.page ?? 1, 10));
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? 20, 10)));
  const skip = (page - 1) * limit;

  const where = {
    userId,
    deletedAt: null,
    ...(trainingId && { trainingId }),
    ...(status && { status }),
    ...(dateFrom || dateTo
      ? {
          startedAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo && { lte: new Date(dateTo) }),
          },
        }
      : {}),
  };

  const [sessions, total] = await Promise.all([
    prisma.workoutSession.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip,
      take: limit,
      include: {
        training: { select: { id: true, name: true, category: true, estimatedDurationSeconds: true } },
      },
    }),
    prisma.workoutSession.count({ where }),
  ]);

  return { data: sessions, total, page, limit };
}

/**
 * Get a single workout session with full exercise and set log detail.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function getSession(userId, sessionId) {
  const session = await prisma.workoutSession.findUnique({
    where: { id: sessionId },
    include: {
      training: { select: { id: true, name: true, category: true, estimatedDurationSeconds: true } },
      exerciseLogs: {
        orderBy: { order: 'asc' },
        include: {
          exercise: exerciseSelectWithSubstitutes,
          setLogs: { orderBy: { setNumber: 'asc' } },
        },
      },
    },
  });

  if (!session || session.deletedAt) {
    throw buildError('WORKOUT_SESSION_NOT_FOUND', 'Workout session not found', 404);
  }

  if (session.userId !== userId) {
    throw buildError('FORBIDDEN_NOT_YOUR_SESSION', 'This session does not belong to you', 403);
  }

  return session;
}

/**
 * Update a workout session (finish, abandon, or update notes).
 * Calculates durationSeconds automatically when status changes to completed/abandoned.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {object} data - { status, notes }
 * @returns {Promise<object>}
 */
export async function updateSession(userId, sessionId, data) {
  const session = await resolveUserSession(sessionId, userId);

  const updateData = {};

  if (data.notes !== undefined) {
    updateData.notes = data.notes;
  }

  if (data.status !== undefined) {
    const isTerminal =
      data.status === WorkoutSessionStatus.COMPLETED ||
      data.status === WorkoutSessionStatus.ABANDONED;

    if (isTerminal) {
      const finishedAt = new Date();
      updateData.finishedAt = finishedAt;
      updateData.durationSeconds = Math.round(
        (finishedAt.getTime() - session.startedAt.getTime()) / 1000,
      );
    }

    updateData.status = data.status;
  }

  const updated = await prisma.workoutSession.update({
    where: { id: sessionId },
    data: updateData,
    include: {
      training: { select: { id: true, name: true, category: true, estimatedDurationSeconds: true } },
      exerciseLogs: {
        orderBy: { order: 'asc' },
        include: {
          exercise: exerciseSelectWithSubstitutes,
          setLogs: { orderBy: { setNumber: 'asc' } },
        },
      },
    },
  });

  // Fire-and-forget: award points for workout completion.
  // This must never block or fail the session update.
  if (data.status === WorkoutSessionStatus.COMPLETED) {
    awardWorkoutCompletionPoints({ prisma, userId, workoutSession: updated })
      .catch((err) => console.error('Failed to award workout completion points', err));

    // Denormalize lastWorkoutAt on TrainerStudent for the students-list hot path.
    if (updated.finishedAt) {
      bumpLastWorkoutAt(userId, updated.finishedAt).catch(() => {});
    }
  }

  // Status changes affect adherence, activeStudents, and inactiveStudents KPIs
  if (data.status !== undefined) {
    invalidateBriefingForTraining(updated.trainingId).catch(() => {});
  }

  return updated;
}

/**
 * Soft-delete a workout session.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function deleteSession(userId, sessionId) {
  const session = await resolveUserSession(sessionId, userId);

  const deleted = await prisma.workoutSession.update({
    where: { id: sessionId },
    data: { deletedAt: new Date() },
  });

  // Removing a session affects adherence denominator
  invalidateBriefingForTraining(session.trainingId).catch(() => {});

  return deleted;
}

/**
 * Update an exercise log (status, notes).
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} exerciseLogId
 * @param {object} data - { status, notes }
 * @returns {Promise<object>}
 */
export async function updateExerciseLog(userId, sessionId, exerciseLogId, data) {
  await resolveExerciseLog(exerciseLogId, sessionId, userId);

  const updateData = {};
  if (data.status !== undefined) updateData.status = data.status;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await prisma.exerciseLog.update({
    where: { id: exerciseLogId },
    data: updateData,
    include: { setLogs: { orderBy: { setNumber: 'asc' } } },
  });

  return updated;
}

/**
 * Log a set for an exercise.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} exerciseLogId
 * @param {object} data - { setNumber, repetitions, load, duration, rpe, restSeconds, completed, notes }
 * @returns {Promise<object>}
 */
export async function createSetLog(userId, sessionId, exerciseLogId, data) {
  const exerciseLog = await resolveExerciseLog(exerciseLogId, sessionId, userId);

  const setLog = await prisma.setLog.create({
    data: {
      exerciseLogId,
      setNumber: data.setNumber,
      repetitions: data.repetitions ?? null,
      load: data.load ?? null,
      duration: data.duration ?? null,
      rpe: data.rpe ?? null,
      restSeconds: data.restSeconds ?? null,
      completed: data.completed !== undefined ? data.completed : true,
      notes: data.notes ?? null,
    },
  });

  // Set logs with load affect stagnant progress KPI
  if (data.load != null) {
    invalidateBriefingForTraining(exerciseLog.workoutSession.trainingId).catch(() => {});
  }

  // Denormalize PR on TrainerStudent for the students-list hot path.
  maybePromotePr(userId, data.load, setLog.completed).catch(() => {});

  return setLog;
}

/**
 * Update a set log.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} exerciseLogId
 * @param {string} setLogId
 * @param {object} data
 * @returns {Promise<object>}
 */
export async function updateSetLog(userId, sessionId, exerciseLogId, setLogId, data) {
  const exerciseLog = await resolveExerciseLog(exerciseLogId, sessionId, userId);
  await resolveSetLog(setLogId, exerciseLogId);

  const updateData = {};
  if (data.setNumber !== undefined) updateData.setNumber = data.setNumber;
  if (data.repetitions !== undefined) updateData.repetitions = data.repetitions;
  if (data.load !== undefined) updateData.load = data.load;
  if (data.duration !== undefined) updateData.duration = data.duration;
  if (data.rpe !== undefined) updateData.rpe = data.rpe;
  if (data.restSeconds !== undefined) updateData.restSeconds = data.restSeconds;
  if (data.completed !== undefined) updateData.completed = data.completed;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await prisma.setLog.update({
    where: { id: setLogId },
    data: updateData,
  });

  // Load changes affect stagnant progress KPI.
  // != null: skip explicit nulls (clearing the load doesn't change the PR
  // history) — match createSetLog at L470.
  if (data.load != null) {
    invalidateBriefingForTraining(exerciseLog.workoutSession.trainingId).catch(() => {});
  }

  // Denormalize PR on TrainerStudent for the students-list hot path.
  // updated.completed reflects current persisted state — required since the
  // user may not have included `completed` in this patch.
  maybePromotePr(userId, data.load, updated.completed).catch(() => {});

  return updated;
}

/**
 * Delete a set log.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} exerciseLogId
 * @param {string} setLogId
 * @returns {Promise<object>}
 */
export async function deleteSetLog(userId, sessionId, exerciseLogId, setLogId) {
  const exerciseLog = await resolveExerciseLog(exerciseLogId, sessionId, userId);
  await resolveSetLog(setLogId, exerciseLogId);

  const deleted = await prisma.setLog.delete({
    where: { id: setLogId },
  });

  // Removing a set log can affect load-based PR calculations
  invalidateBriefingForTraining(exerciseLog.workoutSession.trainingId).catch(() => {});

  return deleted;
}

// ─── Trainer operations ───────────────────────────────────────────────────────

/**
 * List workout sessions for a student (trainer view).
 *
 * @param {string} trainerId - User ID of the trainer
 * @param {string} studentId - User ID of the student
 * @param {object} filters - { trainingId, status, dateFrom, dateTo, page, limit }
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function listStudentSessions(trainerId, studentId, filters = {}) {
  await resolveTrainerStudent(trainerId, studentId);

  const { trainingId, status, dateFrom, dateTo } = filters;
  const page = Math.max(1, parseInt(filters.page ?? 1, 10));
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? 20, 10)));
  const skip = (page - 1) * limit;

  const where = {
    userId: studentId,
    deletedAt: null,
    ...(trainingId && { trainingId }),
    ...(status && { status }),
    ...(dateFrom || dateTo
      ? {
          startedAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo && { lte: new Date(dateTo) }),
          },
        }
      : {}),
  };

  const [sessions, total] = await Promise.all([
    prisma.workoutSession.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip,
      take: limit,
      include: {
        training: { select: { id: true, name: true, category: true, estimatedDurationSeconds: true } },
      },
    }),
    prisma.workoutSession.count({ where }),
  ]);

  return { data: sessions, total, page, limit };
}

/**
 * Substitute an exercise log with a substitute exercise.
 *
 * Marks the principal ExerciseLog status as 'substituted' and sets
 * substitutedByExerciseId. Creates a new ExerciseLog for the substitute
 * exercise in the same session, ordered immediately after the principal.
 * Idempotent: re-calling with the same substituteExerciseId is a no-op.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} exerciseLogId - The principal ExerciseLog ID
 * @param {string} substituteExerciseId - The Exercise.id of the substitute to use
 * @returns {Promise<object>} The new ExerciseLog for the substitute exercise
 */
export async function substituteExerciseLog(userId, sessionId, exerciseLogId, substituteExerciseId) {
  const principalLog = await resolveExerciseLog(exerciseLogId, sessionId, userId);

  // Idempotent: if already substituted with the same exercise, return existing log
  if (
    principalLog.status === ExerciseLogStatus.SUBSTITUTED &&
    principalLog.substitutedByExerciseId === substituteExerciseId
  ) {
    const existing = await prisma.exerciseLog.findFirst({
      where: { workoutSessionId: sessionId, exerciseId: substituteExerciseId },
      include: { setLogs: { orderBy: { setNumber: 'asc' } } },
    });
    if (existing) return existing;
  }

  if (principalLog.status === ExerciseLogStatus.SUBSTITUTED) {
    throw new AppError({
      httpStatus: 409,
      error: 'EXERCISE_LOG_ALREADY_SUBSTITUTED',
      messageCode: SubstituteMessageCode.LOG_ALREADY_SUBSTITUTED,
      message: 'This exercise log has already been substituted',
      details: { substitutedByExerciseId: principalLog.substitutedByExerciseId },
    });
  }

  // Load the substitute Exercise and validate it is a substitute for the principal exercise
  const substituteExercise = await prisma.exercise.findUnique({
    where: { id: substituteExerciseId },
  });

  if (!substituteExercise || substituteExercise.deletedAt) {
    throw buildError('EXERCISE_NOT_FOUND', 'Substitute exercise not found', 404);
  }

  if (substituteExercise.substituteForExerciseId !== principalLog.exerciseId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.NOT_FOUND,
      message: 'The specified exercise is not a substitute for this exercise log',
    });
  }

  const newLog = await prisma.$transaction(async (tx) => {
    // Shift all logs after the principal up by 1 so the substitute lands at an integer slot
    await tx.exerciseLog.updateMany({
      where: {
        workoutSessionId: sessionId,
        order: { gt: principalLog.order },
      },
      data: { order: { increment: 1 } },
    });

    // Mark principal as substituted
    await tx.exerciseLog.update({
      where: { id: exerciseLogId },
      data: {
        status: ExerciseLogStatus.SUBSTITUTED,
        substitutedByExerciseId: substituteExerciseId,
      },
    });

    return tx.exerciseLog.create({
      data: {
        workoutSessionId: sessionId,
        exerciseId: substituteExerciseId,
        status: ExerciseLogStatus.PENDING,
        order: principalLog.order + 1,
      },
      include: { setLogs: { orderBy: { setNumber: 'asc' } } },
    });
  });

  return newLog;
}

/**
 * Undo a substitute exercise swap within the 15-second window before any set is logged.
 *
 * Finds the principal ExerciseLog whose `substitutedByExerciseId` matches the
 * substitute log's `exerciseId`, resets the principal to PENDING, hard-deletes the
 * substitute log, and shifts all downstream logs (order > substituteLog.order) back by -1.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} exerciseLogId - The substitute ExerciseLog ID (NOT the principal)
 * @returns {Promise<void>}
 */
export async function undoSubstituteExerciseLog(userId, sessionId, exerciseLogId) {
  const substituteLog = await resolveExerciseLog(exerciseLogId, sessionId, userId);

  // Confirm the candidate log is actually a substitute (a principal in the same session
  // must reference its exerciseId via substitutedByExerciseId).
  const principalLog = await prisma.exerciseLog.findFirst({
    where: {
      workoutSessionId: sessionId,
      substitutedByExerciseId: substituteLog.exerciseId,
    },
  });

  if (!principalLog) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.UNDO_NOT_SUBSTITUTE,
      message: 'This log is not a substitute exercise. Use this endpoint only to undo swaps.',
    });
  }

  const setCount = await prisma.setLog.count({
    where: { exerciseLogId },
  });

  if (setCount > 0) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.UNDO_HAS_SETS,
      message: 'Cannot undo swap: sets have already been logged for this exercise.',
    });
  }

  await prisma.$transaction(async (tx) => {
    // Reset principal: clear substitution marker and restore PENDING status
    await tx.exerciseLog.update({
      where: { id: principalLog.id },
      data: {
        status: ExerciseLogStatus.PENDING,
        substitutedByExerciseId: null,
      },
    });

    // Hard-delete the substitute log (no deletedAt column on ExerciseLog)
    await tx.exerciseLog.delete({
      where: { id: exerciseLogId },
    });

    // Shift all logs after the deleted substitute back by -1
    await tx.exerciseLog.updateMany({
      where: {
        workoutSessionId: sessionId,
        order: { gt: substituteLog.order },
      },
      data: { order: { decrement: 1 } },
    });
  });
}

/**
 * Get full detail of a student's workout session (trainer view).
 *
 * @param {string} trainerId - User ID of the trainer
 * @param {string} studentId - User ID of the student
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function getStudentSession(trainerId, studentId, sessionId) {
  await resolveTrainerStudent(trainerId, studentId);

  const session = await prisma.workoutSession.findUnique({
    where: { id: sessionId },
    include: {
      training: { select: { id: true, name: true, category: true, estimatedDurationSeconds: true } },
      exerciseLogs: {
        orderBy: { order: 'asc' },
        include: {
          exercise: exerciseSelectWithSubstitutes,
          setLogs: { orderBy: { setNumber: 'asc' } },
        },
      },
    },
  });

  if (!session || session.deletedAt) {
    throw buildError('WORKOUT_SESSION_NOT_FOUND', 'Workout session not found', 404);
  }

  if (session.userId !== studentId) {
    throw buildError('FORBIDDEN_NOT_YOUR_SESSION', 'This session does not belong to this student', 403);
  }

  return session;
}

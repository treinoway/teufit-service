import { AppError, NotFoundAppError } from '../errors/app-error.js';
import { formatDateOnly } from '../helpers/date-helpers.js';
import { computeBestSet, resolveEffectiveExerciseId } from '../helpers/best-set.js';
import { WorkoutSessionStatus } from '../constants/training.js';
import { countPendingItems, getOverviewQuery } from './admin-overview-service.js';
import {
  ADMIN_MANAGER_ERROR_UNAVAILABLE,
  ADMIN_MANAGER_PAGE_SIZE_DEFAULT,
  ADMIN_MANAGER_PROTOCOL_PERSPECTIVE,
  ADMIN_MANAGER_TEMPLATE_TYPE,
  ADMIN_MANAGER_USER_KIND,
  AdminManagerMessageCode,
  POSTGRES_STATEMENT_TIMEOUT_CODE,
} from '../constants/admin-manager.js';

const DEFAULT_PAGE = 1;
const MAX_CAUSE_DEPTH = 5;
const PRISMA_POOL_TIMEOUT_CODE = 'P2024';
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const HTTP_UNAVAILABLE = 503;
const NEWEST_FIRST_ORDER = [{ createdAt: 'desc' }, { id: 'asc' }];
const NAME_SELECT = { select: { firstName: true, lastName: true } };

// Lists the places a Postgres error code can sit on a raw pg or Prisma-wrapped error.
function collectErrorCodes(error) {
  const adapterCause = error.meta?.driverAdapterError?.cause;
  return [error.code, error.meta?.code, adapterCause?.code, adapterCause?.originalCode];
}

// Tells whether the error is a pool connection-acquire timeout (pg message or Prisma P2024).
function isPoolConnectionTimeout(error) {
  return error.code === PRISMA_POOL_TIMEOUT_CODE || String(error.message ?? '').includes(POOL_CONNECT_TIMEOUT_MESSAGE);
}

// Tells whether the error, or anything in its cause chain, is a statement or pool connection timeout.
function isStatementTimeout(error, depth = 0) {
  if (!error || depth > MAX_CAUSE_DEPTH) return false;
  if (collectErrorCodes(error).includes(POSTGRES_STATEMENT_TIMEOUT_CODE)) return true;
  if (isPoolConnectionTimeout(error)) return true;
  return isStatementTimeout(error.cause, depth + 1);
}

// Converts a statement timeout into the 503 contract error and rethrows anything else untouched.
function rethrowMappingTimeout(error) {
  if (!isStatementTimeout(error)) throw error;
  throw new AppError({
    httpStatus: HTTP_UNAVAILABLE,
    error: ADMIN_MANAGER_ERROR_UNAVAILABLE,
    messageCode: AdminManagerMessageCode.QUERY_TIMEOUT,
    message: 'The query took too long. Narrow the search and try again.',
    details: {},
    cause: error,
  });
}

// Wraps a query function so statement timeouts surface as AppError admin.queryTimeout.
function withTimeoutMapping(queryFunction) {
  return async (adminDb, params) => {
    try {
      return await queryFunction(adminDb, params);
    } catch (error) {
      return rethrowMappingTimeout(error);
    }
  };
}

// Normalizes page and pageSize and derives the offset.
function toPagination({ page, pageSize } = {}) {
  const resolvedPage = page ?? DEFAULT_PAGE;
  const resolvedPageSize = pageSize ?? ADMIN_MANAGER_PAGE_SIZE_DEFAULT;
  return { page: resolvedPage, pageSize: resolvedPageSize, skip: (resolvedPage - 1) * resolvedPageSize };
}

// Builds the paginated response envelope.
function toPage(items, total, { page, pageSize }) {
  return { items, total, page, pageSize };
}

// Joins first and last name into a display name ('' when both are empty).
function toFullName(person) {
  return [person?.firstName, person?.lastName].filter(Boolean).join(' ');
}

// Reads a name part as a string ('' when the user has not filled it in).
function toNamePart(value) {
  return value ?? '';
}

// Builds the filter for one search token across first name, last name and email.
function buildTokenFilter(token) {
  const contains = { contains: token, mode: 'insensitive' };
  return { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] };
}

// Builds the user filter for the kind (students are users with any TrainerStudent row).
function buildKindFilter(kind) {
  if (!kind) return [];
  if (kind === ADMIN_MANAGER_USER_KIND.STUDENT) return [{ trainers: { some: {} } }];
  return [{ roles: { has: kind } }];
}

// Builds the combined user list filter from search tokens and kind.
function buildUserWhere({ search, kind }) {
  const tokens = (search ?? '').split(/\s+/).filter(Boolean);
  const filters = [...tokens.map(buildTokenFilter), ...buildKindFilter(kind)];
  return filters.length > 0 ? { AND: filters } : {};
}

// Maps a user list row to the API item.
function toUserListItem(user) {
  return {
    id: user.id,
    firstName: toNamePart(user.firstName),
    lastName: toNamePart(user.lastName),
    email: user.email,
    roles: user.roles,
    isTrainer: Boolean(user.trainer),
    isStudent: user.trainers.length > 0,
    status: user.status,
    createdAt: user.createdAt,
    deletedAt: user.deletedAt,
  };
}

// Lists users (including soft-deleted) with search, kind filter and offset pagination.
async function listUsersQuery(adminDb, { search, kind, ...pagination } = {}) {
  const paging = toPagination(pagination);
  const where = buildUserWhere({ search, kind });
  const [rows, total] = await Promise.all([
    adminDb.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        roles: true,
        status: true,
        createdAt: true,
        deletedAt: true,
        trainer: { select: { id: true } },
        trainers: { select: { id: true }, take: 1 },
      },
      orderBy: NEWEST_FIRST_ORDER,
      skip: paging.skip,
      take: paging.pageSize,
    }),
    adminDb.user.count({ where }),
  ]);
  return toPage(rows.map(toUserListItem), total, paging);
}

// Finds the trainer profile id for a user, or null when the user is not a trainer.
async function findTrainerId(adminDb, userId) {
  const trainer = await adminDb.trainer.findUnique({ where: { userId }, select: { id: true } });
  return trainer?.id ?? null;
}

// Counts the trainer-owned records for a trainer profile (all zero without one).
async function countTrainerRecords(adminDb, trainerId) {
  if (!trainerId) {
    return { students: 0, activeStudents: 0, protocolsCreated: 0, trainingTemplates: 0, exerciseTemplates: 0, challenges: 0 };
  }
  const [students, activeStudents, protocolsCreated, trainingTemplates, exerciseTemplates, challenges] = await Promise.all([
    adminDb.trainerStudent.count({ where: { trainerId } }),
    adminDb.trainerStudent.count({ where: { trainerId, activeOnPlan: true } }),
    adminDb.trainingProtocol.count({ where: { trainerId } }),
    adminDb.trainingTemplate.count({ where: { trainerId } }),
    adminDb.exerciseTemplate.count({ where: { trainerId } }),
    adminDb.challenge.count({ where: { trainerId } }),
  ]);
  return { students, activeStudents, protocolsCreated, trainingTemplates, exerciseTemplates, challenges };
}

// Counts the student-side records for a user.
async function countStudentRecords(adminDb, userId) {
  const [trainers, protocolsAssigned, workoutSessions] = await Promise.all([
    adminDb.trainerStudent.count({ where: { studentId: userId } }),
    adminDb.trainingProtocol.count({ where: { assigneeId: userId } }),
    adminDb.workoutSession.count({ where: { userId } }),
  ]);
  return { trainers, protocolsAssigned, workoutSessions };
}

// Builds the trainer block of the overview (null when the user has no trainer profile).
function toTrainerSummary(trainer) {
  if (!trainer) return null;
  return { id: trainer.id, createdAt: trainer.createdAt, planTier: trainer.platformSubscription?.tier ?? null };
}

// Returns the profile, trainer summary, counts and last workout of one user.
async function getUserOverviewQuery(adminDb, { userId }) {
  const user = await adminDb.user.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true, email: true, roles: true, status: true, createdAt: true, deletedAt: true },
  });
  if (!user) {
    throw new NotFoundAppError({ messageCode: AdminManagerMessageCode.USER_NOT_FOUND, message: 'User not found', details: {} });
  }
  const trainer = await adminDb.trainer.findUnique({
    where: { userId },
    select: { id: true, createdAt: true, platformSubscription: { select: { tier: true } } },
  });
  const [trainerCounts, studentCounts, lastSession] = await Promise.all([
    countTrainerRecords(adminDb, trainer?.id ?? null),
    countStudentRecords(adminDb, userId),
    adminDb.workoutSession.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
  ]);
  return {
    user: { ...user, firstName: toNamePart(user.firstName), lastName: toNamePart(user.lastName) },
    trainer: toTrainerSummary(trainer),
    counts: { ...trainerCounts, ...studentCounts },
    lastWorkoutAt: lastSession?.startedAt ?? null,
  };
}

// Maps a TrainerStudent row to a trainer's student item.
function toStudentItem(link) {
  return {
    studentId: link.studentId,
    firstName: toNamePart(link.student.firstName),
    lastName: toNamePart(link.student.lastName),
    email: link.student.email,
    status: link.student.status,
    activeOnPlan: link.activeOnPlan,
    lastWorkoutAt: link.lastWorkoutAt,
    linkedAt: link.createdAt,
  };
}

// Lists the students linked to a trainer user (empty for non-trainers).
async function listUserStudentsQuery(adminDb, { userId, ...pagination }) {
  const paging = toPagination(pagination);
  const trainerId = await findTrainerId(adminDb, userId);
  if (!trainerId) return toPage([], 0, paging);
  const where = { trainerId };
  const [rows, total] = await Promise.all([
    adminDb.trainerStudent.findMany({
      where,
      select: {
        studentId: true,
        activeOnPlan: true,
        lastWorkoutAt: true,
        createdAt: true,
        student: { select: { firstName: true, lastName: true, email: true, status: true } },
      },
      orderBy: NEWEST_FIRST_ORDER,
      skip: paging.skip,
      take: paging.pageSize,
    }),
    adminDb.trainerStudent.count({ where }),
  ]);
  return toPage(rows.map(toStudentItem), total, paging);
}

// Maps a TrainerStudent row to a student's trainer item.
function toTrainerItem(link) {
  const { user } = link.trainer;
  return {
    trainerId: link.trainerId,
    userId: link.trainer.userId,
    firstName: toNamePart(user.firstName),
    lastName: toNamePart(user.lastName),
    email: user.email,
    status: user.status,
    linkedAt: link.createdAt,
  };
}

// Lists the trainers a user is linked to as a student.
async function listUserTrainersQuery(adminDb, { userId, ...pagination }) {
  const paging = toPagination(pagination);
  const where = { studentId: userId };
  const [rows, total] = await Promise.all([
    adminDb.trainerStudent.findMany({
      where,
      select: {
        trainerId: true,
        createdAt: true,
        trainer: {
          select: { userId: true, user: { select: { firstName: true, lastName: true, email: true, status: true } } },
        },
      },
      orderBy: NEWEST_FIRST_ORDER,
      skip: paging.skip,
      take: paging.pageSize,
    }),
    adminDb.trainerStudent.count({ where }),
  ]);
  return toPage(rows.map(toTrainerItem), total, paging);
}

// Builds the protocol filter for protocols created by (trainer) or assigned to (student) a user.
function buildProtocolWhere(userId, perspective) {
  if (perspective === ADMIN_MANAGER_PROTOCOL_PERSPECTIVE.STUDENT) return { assigneeId: userId };
  return { trainer: { userId } };
}

// Maps a protocol row to the list item.
function toProtocolListItem(protocol) {
  return {
    id: protocol.id,
    name: protocol.name,
    trainerName: toFullName(protocol.trainer?.user),
    assigneeName: toFullName(protocol.assignee),
    startDate: formatDateOnly(protocol.startDate),
    endDate: formatDateOnly(protocol.expirationDate),
    trainingsCount: protocol._count.trainings,
    createdAt: protocol.createdAt,
    deletedAt: protocol.deletedAt,
  };
}

// Lists protocols created by or assigned to a user, newest first.
async function listUserProtocolsQuery(adminDb, { userId, as, ...pagination }) {
  const paging = toPagination(pagination);
  const where = buildProtocolWhere(userId, as);
  const [rows, total] = await Promise.all([
    adminDb.trainingProtocol.findMany({
      where,
      select: {
        id: true,
        name: true,
        startDate: true,
        expirationDate: true,
        createdAt: true,
        deletedAt: true,
        trainer: { select: { user: NAME_SELECT } },
        assignee: NAME_SELECT,
        _count: { select: { trainings: { where: { deletedAt: null } } } },
      },
      orderBy: NEWEST_FIRST_ORDER,
      skip: paging.skip,
      take: paging.pageSize,
    }),
    adminDb.trainingProtocol.count({ where }),
  ]);
  return toPage(rows.map(toProtocolListItem), total, paging);
}

// Maps an exercise row to the raw stored prescription item.
function toExerciseItem(exercise) {
  return {
    id: exercise.id,
    name: exercise.name,
    order: exercise.order,
    sets: exercise.sets,
    repetitions: exercise.repetitions,
    prescriptionMode: exercise.prescriptionMode,
    duration: exercise.duration,
    hasLoad: exercise.hasLoad,
    suggestedLoad: exercise.suggestedLoad,
    restInterval: exercise.restInterval,
    notes: exercise.notes,
  };
}

// Maps a protocol detail row to the API shape with ordered trainings and exercises.
function toProtocolDetail(protocol) {
  return {
    id: protocol.id,
    name: protocol.name,
    description: protocol.description,
    status: protocol.status,
    trainerName: toFullName(protocol.trainer?.user),
    assigneeName: toFullName(protocol.assignee),
    startDate: formatDateOnly(protocol.startDate),
    endDate: formatDateOnly(protocol.expirationDate),
    createdAt: protocol.createdAt,
    deletedAt: protocol.deletedAt,
    trainings: protocol.trainings.map((training) => ({
      id: training.id,
      name: training.name,
      order: training.order,
      exercises: training.exercises.map(toExerciseItem),
    })),
  };
}

// Returns one protocol with its trainings and exercises, both ordered by `order`.
async function getProtocolDetailQuery(adminDb, { protocolId }) {
  const protocol = await adminDb.trainingProtocol.findUnique({
    where: { id: protocolId },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      startDate: true,
      expirationDate: true,
      createdAt: true,
      deletedAt: true,
      trainer: { select: { user: NAME_SELECT } },
      assignee: NAME_SELECT,
      trainings: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          name: true,
          order: true,
          exercises: {
            where: { deletedAt: null, substituteForExerciseId: null },
            orderBy: { order: 'asc' },
            select: {
              id: true,
              name: true,
              order: true,
              sets: true,
              repetitions: true,
              prescriptionMode: true,
              duration: true,
              hasLoad: true,
              suggestedLoad: true,
              restInterval: true,
              notes: true,
            },
          },
        },
      },
    },
  });
  if (!protocol) {
    throw new NotFoundAppError({ messageCode: AdminManagerMessageCode.PROTOCOL_NOT_FOUND, message: 'Protocol not found', details: {} });
  }
  return toProtocolDetail(protocol);
}

// Picks the template model for the requested template type.
function pickTemplateModel(adminDb, type) {
  return type === ADMIN_MANAGER_TEMPLATE_TYPE.EXERCISE ? adminDb.exerciseTemplate : adminDb.trainingTemplate;
}

// Lists a trainer user's training or exercise templates (empty for non-trainers).
async function listUserTemplatesQuery(adminDb, { userId, type, ...pagination }) {
  const paging = toPagination(pagination);
  const trainerId = await findTrainerId(adminDb, userId);
  if (!trainerId) return toPage([], 0, paging);
  const model = pickTemplateModel(adminDb, type);
  const where = { trainerId };
  const [items, total] = await Promise.all([
    model.findMany({
      where,
      select: { id: true, name: true, createdAt: true, deletedAt: true },
      orderBy: NEWEST_FIRST_ORDER,
      skip: paging.skip,
      take: paging.pageSize,
    }),
    model.count({ where }),
  ]);
  return toPage(items, total, paging);
}

// Maps a workout session row to the API item.
function toSessionItem(session) {
  return {
    id: session.id,
    trainingName: session.training?.name ?? null,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    durationSec: session.durationSeconds,
    deletedAt: session.deletedAt,
  };
}

// Lists a user's workout sessions, newest first.
async function listUserSessionsQuery(adminDb, { userId, ...pagination }) {
  const paging = toPagination(pagination);
  const where = { userId };
  const [rows, total] = await Promise.all([
    adminDb.workoutSession.findMany({
      where,
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        durationSeconds: true,
        deletedAt: true,
        training: { select: { name: true } },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      skip: paging.skip,
      take: paging.pageSize,
    }),
    adminDb.workoutSession.count({ where }),
  ]);
  return toPage(rows.map(toSessionItem), total, paging);
}

const SESSION_DETAIL_SELECT = {
  id: true,
  userId: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  durationSeconds: true,
  notes: true,
  deletedAt: true,
  training: { select: { id: true, name: true } },
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  exerciseLogs: {
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      exerciseId: true,
      order: true,
      status: true,
      notes: true,
      substitutedByExerciseId: true,
      exercise: {
        select: {
          id: true,
          name: true,
          sets: true,
          repetitions: true,
          prescriptionMode: true,
          duration: true,
          hasLoad: true,
          suggestedLoad: true,
          restInterval: true,
        },
      },
      setLogs: {
        orderBy: [{ setNumber: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          setNumber: true,
          repetitions: true,
          load: true,
          duration: true,
          rpe: true,
          restSeconds: true,
          completed: true,
          notes: true,
        },
      },
    },
  },
};

// Finds, per effective exercise, the student's latest completed non-deleted log finished before the cutoff.
function findPreviousExerciseLogRows(adminDb, { userId, exerciseIds, finishedBefore }) {
  return adminDb.$queryRaw`
    SELECT DISTINCT ON (el.exercise_id)
      el.id,
      el.exercise_id,
      el.workout_session_id,
      ws.finished_at
    FROM exercise_logs el
    JOIN workout_sessions ws ON ws.id = el.workout_session_id
    WHERE el.exercise_id = ANY(${exerciseIds}::uuid[])
      AND ws.user_id = ${userId}::uuid
      AND ws.status = ${WorkoutSessionStatus.COMPLETED}
      AND ws.deleted_at IS NULL
      AND ws.finished_at < ${finishedBefore}::timestamptz
    ORDER BY el.exercise_id, ws.finished_at DESC, el.id
  `;
}

// Loads the completed sets of the given exercise logs, grouped by exercise log id.
async function loadCompletedSetsByExerciseLog(adminDb, exerciseLogIds) {
  const setLogs = await adminDb.setLog.findMany({
    where: { exerciseLogId: { in: exerciseLogIds }, completed: true },
    select: { exerciseLogId: true, setNumber: true, repetitions: true, load: true, duration: true, rpe: true, restSeconds: true, completed: true },
    orderBy: [{ exerciseLogId: 'asc' }, { setNumber: 'asc' }],
  });
  const setsByExerciseLog = new Map();
  for (const setLog of setLogs) {
    setsByExerciseLog.set(setLog.exerciseLogId, [...(setsByExerciseLog.get(setLog.exerciseLogId) ?? []), setLog]);
  }
  return setsByExerciseLog;
}

// Maps a previous exercise log row and its completed sets to the previousLog shape.
function toPreviousLog(row, completedSets) {
  return {
    workoutSessionId: row.workout_session_id,
    finishedAt: row.finished_at,
    setLogs: completedSets.map(({ setNumber, repetitions, load, duration }) => ({ setNumber, repetitions, load, duration })),
    bestSet: computeBestSet(completedSets),
  };
}

// Returns the previousLog per effective exercise id, as the student saw it when this session started.
async function loadPreviousLogsByExercise(adminDb, session) {
  const exerciseIds = [...new Set(session.exerciseLogs.map(resolveEffectiveExerciseId))];
  if (exerciseIds.length === 0) return new Map();
  const rows = await findPreviousExerciseLogRows(adminDb, { userId: session.userId, exerciseIds, finishedBefore: session.startedAt });
  if (rows.length === 0) return new Map();
  const setsByExerciseLog = await loadCompletedSetsByExerciseLog(adminDb, rows.map((row) => row.id));
  return new Map(rows.map((row) => [row.exercise_id, toPreviousLog(row, setsByExerciseLog.get(row.id) ?? [])]));
}

// Returns the names of the substitute exercises used in the session, keyed by exercise id.
async function loadSubstituteNames(adminDb, exerciseLogs) {
  const substituteIds = [...new Set(exerciseLogs.map((log) => log.substitutedByExerciseId).filter(Boolean))];
  if (substituteIds.length === 0) return new Map();
  const exercises = await adminDb.exercise.findMany({ where: { id: { in: substituteIds } }, select: { id: true, name: true } });
  return new Map(exercises.map((exercise) => [exercise.id, exercise.name]));
}

// Maps an exercise log row to the API item with its substitute name and previousLog.
function toSessionExerciseLog(log, { substituteNames, previousLogs }) {
  return {
    id: log.id,
    order: log.order,
    status: log.status,
    notes: log.notes,
    exercise: log.exercise,
    substitutedByExerciseId: log.substitutedByExerciseId,
    substitutedByExerciseName: substituteNames.get(log.substitutedByExerciseId) ?? null,
    setLogs: log.setLogs,
    previousLog: previousLogs.get(resolveEffectiveExerciseId(log)) ?? null,
  };
}

// Maps a session row and its lookups to the session detail response.
function toSessionDetail(session, lookups) {
  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    durationSec: session.durationSeconds,
    notes: session.notes,
    deletedAt: session.deletedAt,
    training: session.training,
    student: session.user,
    exerciseLogs: session.exerciseLogs.map((log) => toSessionExerciseLog(log, lookups)),
  };
}

// Returns one workout session (any status, soft-deleted included) with its logs, sets and previous logs.
async function getSessionDetailQuery(adminDb, { sessionId }) {
  const session = await adminDb.workoutSession.findUnique({ where: { id: sessionId }, select: SESSION_DETAIL_SELECT });
  if (!session) {
    throw new NotFoundAppError({ messageCode: AdminManagerMessageCode.SESSION_NOT_FOUND, message: 'Session not found', details: {} });
  }
  const [substituteNames, previousLogs] = await Promise.all([
    loadSubstituteNames(adminDb, session.exerciseLogs),
    loadPreviousLogsByExercise(adminDb, session),
  ]);
  return toSessionDetail(session, { substituteNames, previousLogs });
}

export const listUsers = withTimeoutMapping(listUsersQuery);
export const getUserOverview = withTimeoutMapping(getUserOverviewQuery);
export const listUserStudents = withTimeoutMapping(listUserStudentsQuery);
export const listUserTrainers = withTimeoutMapping(listUserTrainersQuery);
export const listUserProtocols = withTimeoutMapping(listUserProtocolsQuery);
export const getProtocolDetail = withTimeoutMapping(getProtocolDetailQuery);
export const listUserTemplates = withTimeoutMapping(listUserTemplatesQuery);
export const listUserSessions = withTimeoutMapping(listUserSessionsQuery);
export const getSessionDetail = withTimeoutMapping(getSessionDetailQuery);
export const getOverview = withTimeoutMapping(getOverviewQuery);
export const getPending = withTimeoutMapping(countPendingItems);

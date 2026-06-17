import { workoutSessionStatusValues, exerciseLogStatusValues, prescriptionModeValues } from '../../src/constants/training.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

const setLogSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    exerciseLogId: { type: 'string', format: 'uuid' },
    setNumber: { type: 'integer', minimum: 1 },
    repetitions: { type: 'integer', nullable: true },
    load: { type: 'number', nullable: true },
    duration: { type: 'integer', nullable: true },
    rpe: { type: 'integer', minimum: 1, maximum: 10, nullable: true },
    restSeconds: { type: 'integer', nullable: true },
    completed: { type: 'boolean' },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// Minimal substitute shape exposed inside session exercise objects — shown in the swap picker
const substituteExerciseMinimalSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('type', 'exerciseType'),
    substituteOrder: { type: 'integer' },
  },
};

// Base exerciseLog shape — used in routes that do NOT compute previousLog
// (POST start-session, PATCH update-session, POST substitute-exercise-log,
//  PATCH update-exercise-log, trainer GET student session).
const exerciseLogSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    workoutSessionId: { type: 'string', format: 'uuid' },
    exerciseId: { type: 'string', format: 'uuid' },
    // null until the student substitutes this log during a session
    substitutedByExerciseId: { type: 'string', format: 'uuid', nullable: true },
    ...i18nField('status', 'exerciseLogStatus'),
    order: { type: 'integer' },
    notes: { type: 'string', nullable: true },
    exercise: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        ...i18nField('type', 'exerciseType'),
        prescriptionMode: { type: 'string', enum: prescriptionModeValues },
        sets: { type: 'integer', nullable: true },
        repetitions: { nullable: true },
        duration: { type: 'integer', nullable: true },
        hasLoad: { type: 'boolean' },
        suggestedLoad: { type: 'number', nullable: true },
        restInterval: { type: 'integer', nullable: true },
        videoUrl: { type: 'string', nullable: true },
        notes: { type: 'string', nullable: true },
        ...i18nField('intensity', 'exerciseIntensity', { nullable: true }),
        // swap options available to the student for this exercise
        substitutes: { type: 'array', items: substituteExerciseMinimalSchema },
      },
    },
    setLogs: { type: 'array', items: setLogSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// Best set (highest tonnage = load * repetitions) of a session for an exercise.
// Considers only completed sets with non-null load AND repetitions. Null when no
// set qualifies (no history, or every set was incomplete / missing load/reps).
const bestSetSchema = {
  type: ['object', 'null'],
  properties: {
    setNumber: { type: 'integer', minimum: 1 },
    repetitions: { type: 'integer' },
    load: { type: 'number' },
    duration: { type: 'integer', nullable: true },
    rpe: { type: 'integer', minimum: 1, maximum: 10, nullable: true },
    restSeconds: { type: 'integer', nullable: true },
    completed: { type: 'boolean' },
    tonnage: { type: 'number' },
  },
};

// Extended exerciseLog shape — used only for GET session detail (student side),
// which calls attachPreviousLogs() and guarantees the field is present.
// finishedAt is nullable because workout_sessions.finished_at is nullable in Prisma
// (a session may be completed without an explicit finishedAt if it was abandoned early).
const exerciseLogWithPreviousLogSchema = {
  type: 'object',
  properties: {
    ...exerciseLogSchema.properties,
    previousLog: {
      type: ['object', 'null'],
      properties: {
        workoutSessionId: { type: 'string', format: 'uuid' },
        finishedAt: { type: 'string', format: 'date-time', nullable: true },
        setLogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              setNumber: { type: 'integer' },
              repetitions: { type: ['integer', 'null'] },
              load: { type: ['number', 'null'] },
              duration: { type: ['integer', 'null'] },
            },
          },
        },
        bestSet: bestSetSchema,
      },
    },
  },
};

const workoutSessionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    ...i18nField('status', 'workoutSessionStatus'),
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time', nullable: true },
    durationSeconds: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const workoutSessionTrainingSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('category', 'trainingCategory'),
    estimatedDurationSeconds: { type: 'integer', minimum: 0, nullable: true },
  },
};

// workoutSessionDetailSchema — no previousLog.
// Used for POST start-session, PATCH update-session, and trainer GET student session.
const workoutSessionDetailSchema = {
  type: 'object',
  properties: {
    ...workoutSessionSchema.properties,
    training: workoutSessionTrainingSummarySchema,
    exerciseLogs: { type: 'array', items: exerciseLogSchema },
  },
};

// workoutSessionDetailWithPreviousLogSchema — includes previousLog on each exerciseLog.
// Used only for GET /my/workout-sessions/:sessionId, which calls attachPreviousLogs().
const workoutSessionDetailWithPreviousLogSchema = {
  type: 'object',
  properties: {
    ...workoutSessionSchema.properties,
    training: workoutSessionTrainingSummarySchema,
    exerciseLogs: { type: 'array', items: exerciseLogWithPreviousLogSchema },
  },
};

const workoutSessionListItemSchema = {
  type: 'object',
  properties: {
    ...workoutSessionSchema.properties,
    training: workoutSessionTrainingSummarySchema,
  },
};

const paginatedSessionsSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: workoutSessionListItemSchema },
    total: { type: 'integer' },
    page: { type: 'integer' },
    limit: { type: 'integer' },
  },
};

const conflictErrorSchema = {
  type: 'object',
  required: ['error', 'messageCode', 'message'],
  properties: {
    error: { type: 'string' },
    messageCode: { type: 'string' },
    message: { type: 'string' },
    details: {
      type: 'object',
      properties: {
        activeSessionId: { type: 'string', format: 'uuid' },
      },
    },
  },
};

const sessionFinalizedErrorSchema = {
  type: 'object',
  required: ['error', 'messageCode', 'message'],
  properties: {
    error: { type: 'string' },
    messageCode: { type: 'string' },
    message: { type: 'string' },
    details: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', format: 'uuid' },
        status: { type: 'string' },
      },
    },
  },
};

// ─── Workout Session schemas ──────────────────────────────────────────────────

export const startSessionSchema = {
  tags: ['Workout Sessions'],
  summary: 'Start a workout session',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['trainingId'],
    properties: { trainingId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: ['object', 'null'],
    properties: {
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: workoutSessionDetailSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: conflictErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listSessionsSchema = {
  tags: ['Workout Sessions'],
  summary: 'List my workout sessions',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      trainingId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: workoutSessionStatusValues },
      dateFrom: { type: 'string', format: 'date-time' },
      dateTo: { type: 'string', format: 'date-time' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    additionalProperties: false,
  },
  response: {
    200: paginatedSessionsSchema,
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getSessionSchema = {
  tags: ['Workout Sessions'],
  summary: 'Get workout session detail',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId'],
    properties: { sessionId: { type: 'string', format: 'uuid' } },
  },
  response: {
    // Uses the extended schema because this route calls attachPreviousLogs()
    200: workoutSessionDetailWithPreviousLogSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateSessionSchema = {
  tags: ['Workout Sessions'],
  summary: 'Update a workout session (finish, abandon, notes)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId'],
    properties: { sessionId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: workoutSessionStatusValues },
      notes: { type: 'string', nullable: true },
    },
    additionalProperties: false,
  },
  response: {
    200: workoutSessionDetailSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteSessionSchema = {
  tags: ['Workout Sessions'],
  summary: 'Soft-delete a workout session',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId'],
    properties: { sessionId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        deletedAt: { type: 'string', format: 'date-time' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── ExerciseLog schemas ──────────────────────────────────────────────────────

export const updateExerciseLogSchema = {
  tags: ['Workout Sessions'],
  summary: 'Update an exercise log (status, notes)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId', 'exerciseLogId'],
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      exerciseLogId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: exerciseLogStatusValues },
      notes: { type: 'string', nullable: true },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      ...exerciseLogSchema,
      properties: {
        ...exerciseLogSchema.properties,
        exercise: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            ...i18nField('type', 'exerciseType'),
          },
        },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── SetLog schemas ───────────────────────────────────────────────────────────

export const createSetLogSchema = {
  tags: ['Workout Sessions'],
  summary: 'Log a set for an exercise',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId', 'exerciseLogId'],
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      exerciseLogId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['setNumber'],
    properties: {
      setNumber: { type: 'integer', minimum: 1 },
      repetitions: { type: 'integer', minimum: 0 },
      load: { type: 'number', minimum: 0 },
      duration: { type: 'integer', minimum: 0 },
      rpe: { type: 'integer', minimum: 1, maximum: 10 },
      restSeconds: { type: 'integer', minimum: 0 },
      completed: { type: 'boolean' },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: setLogSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateSetLogSchema = {
  tags: ['Workout Sessions'],
  summary: 'Update a set log',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId', 'exerciseLogId', 'setLogId'],
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      exerciseLogId: { type: 'string', format: 'uuid' },
      setLogId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      setNumber: { type: 'integer', minimum: 1 },
      repetitions: { type: 'integer', minimum: 0, nullable: true },
      load: { type: 'number', minimum: 0, nullable: true },
      duration: { type: 'integer', minimum: 0, nullable: true },
      rpe: { type: 'integer', minimum: 1, maximum: 10, nullable: true },
      restSeconds: { type: 'integer', minimum: 0, nullable: true },
      completed: { type: 'boolean' },
      notes: { type: 'string', nullable: true },
    },
    additionalProperties: false,
  },
  response: {
    200: setLogSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteSetLogSchema = {
  tags: ['Workout Sessions'],
  summary: 'Delete a set log',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId', 'exerciseLogId', 'setLogId'],
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      exerciseLogId: { type: 'string', format: 'uuid' },
      setLogId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Trainer schemas ──────────────────────────────────────────────────────────

export const listStudentSessionsSchema = {
  tags: ['Workout Sessions - Trainer'],
  summary: 'List workout sessions for a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: { studentId: { type: 'string', format: 'uuid' } },
  },
  querystring: {
    type: 'object',
    properties: {
      trainingId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: workoutSessionStatusValues },
      dateFrom: { type: 'string', format: 'date-time' },
      dateTo: { type: 'string', format: 'date-time' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    additionalProperties: false,
  },
  response: {
    200: paginatedSessionsSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getStudentSessionSchema = {
  tags: ['Workout Sessions - Trainer'],
  summary: 'Get a student workout session detail',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId', 'sessionId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
      sessionId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: workoutSessionDetailSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Last performance ─────────────────────────────────────────────────────────

const lastPerformanceSetSchema = {
  type: 'object',
  properties: {
    setNumber: { type: 'integer', minimum: 1 },
    repetitions: { type: 'integer', nullable: true },
    load: { type: 'number', nullable: true },
    duration: { type: 'integer', nullable: true },
    rpe: { type: 'integer', minimum: 1, maximum: 10, nullable: true },
    restSeconds: { type: 'integer', nullable: true },
    completed: { type: 'boolean' },
  },
};

export const getExerciseLastPerformanceSchema = {
  tags: ['Workout Sessions'],
  summary: 'Get the last logged performance for a training exercise',
  description:
    'Returns the most recent completed-session sets for the given exercise. ' +
    'Returns 200 with performedAt=null and sets=[] when the exercise has never been logged — ' +
    'avoids 404 handling for the common first-time case.',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['exerciseId'],
    properties: { exerciseId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        performedAt: { type: 'string', format: 'date-time', nullable: true },
        sets: { type: 'array', items: lastPerformanceSetSchema },
        bestSet: bestSetSchema,
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Undo substitute exercise log ────────────────────────────────────────────

export const undoSubstituteExerciseLogSchema = {
  tags: ['Workout Sessions'],
  summary: 'Undo a substitute exercise swap (within the 15-second window before any set is logged)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId', 'exerciseLogId'],
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      exerciseLogId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    204: { type: 'null' },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Substitute exercise log ──────────────────────────────────────────────────

export const substituteExerciseLogSchema = {
  tags: ['Workout Sessions'],
  summary: 'Substitute an exercise with an alternative during a workout session',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['sessionId', 'exerciseLogId'],
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      exerciseLogId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['substituteExerciseId'],
    properties: {
      substituteExerciseId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },
  response: {
    201: exerciseLogSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: sessionFinalizedErrorSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

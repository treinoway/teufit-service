import { workoutSessionStatusValues, exerciseLogStatusValues } from '../../src/constants/training.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';

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

const exerciseLogSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    workoutSessionId: { type: 'string', format: 'uuid' },
    exerciseId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: exerciseLogStatusValues },
    order: { type: 'integer' },
    notes: { type: 'string', nullable: true },
    exercise: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        type: { type: 'string' },
        sets: { type: 'integer', nullable: true },
        repetitions: { nullable: true },
        hasLoad: { type: 'boolean' },
        suggestedLoad: { type: 'number', nullable: true },
        videoUrl: { type: 'string', nullable: true },
        notes: { type: 'string', nullable: true },
      },
    },
    setLogs: { type: 'array', items: setLogSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const workoutSessionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: workoutSessionStatusValues },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time', nullable: true },
    durationSeconds: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const workoutSessionDetailSchema = {
  type: 'object',
  properties: {
    ...workoutSessionSchema.properties,
    training: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        category: { type: 'string' },
      },
    },
    exerciseLogs: { type: 'array', items: exerciseLogSchema },
  },
};

const workoutSessionListItemSchema = {
  type: 'object',
  properties: {
    ...workoutSessionSchema.properties,
    training: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        category: { type: 'string' },
      },
    },
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
    200: workoutSessionDetailSchema,
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
            type: { type: 'string' },
          },
        },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
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

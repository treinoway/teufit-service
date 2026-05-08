import { errorResponseSchema } from './error-response.schema.js';
import { trainingWithExercisesResponseSchema } from './training-route.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const protocolSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    startDate: { type: 'string', format: 'date' },
    expirationDate: { type: 'string', format: 'date', nullable: true },
  },
};

const pendingTrainingSchema = {
  type: 'object',
  nullable: true,
  properties: {
    sessionId: { type: 'string', format: 'uuid' },
    trainingId: { type: 'string', format: 'uuid' },
    startedAt: { type: 'string', format: 'date-time' },
    ...i18nField('status', 'workoutSessionStatus'),
  },
};

const workoutEntrySchema = {
  type: 'object',
  required: ['protocol', 'isRestDay'],
  properties: {
    protocol: protocolSummarySchema,
    targetTraining: {
      ...trainingWithExercisesResponseSchema,
      nullable: true,
    },
    isRestDay: { type: 'boolean' },
    nextScheduledDate: { type: 'string', format: 'date', nullable: true },
  },
};

export const getWorkoutsTodaySchema = {
  tags: ['Workouts Today'],
  summary: 'Get the workout(s) the authenticated student should do today',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      required: ['workouts'],
      properties: {
        workouts: {
          type: 'array',
          items: workoutEntrySchema,
        },
        pendingTraining: pendingTrainingSchema,
      },
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

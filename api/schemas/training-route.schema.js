import { trainingCategoryValues, bodySegmentValues, weekDayValues } from '../../src/constants/training.js';

const trainingResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    protocolId: { type: 'string', format: 'uuid' },
    trainingTemplateId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    category: { type: 'string' },
    bodySegment: { type: 'string', nullable: true },
    order: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const scheduleResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingId: { type: 'string', format: 'uuid' },
    weekDay: { type: 'string' },
    order: { type: 'integer' },
  },
};

export const createTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Create a training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['protocolId'],
    properties: { protocolId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['name', 'category'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      category: { type: 'string', enum: trainingCategoryValues },
      bodySegment: { type: 'string', enum: bodySegmentValues },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
      trainingTemplateId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },
  response: {
    201: trainingResponseSchema,
    400: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const getTrainingsSchema = {
  tags: ['Trainings'],
  summary: 'Get trainings by protocol',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['protocolId'],
    properties: { protocolId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'array',
      items: trainingResponseSchema,
    },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const getTrainingByIdSchema = {
  tags: ['Trainings'],
  summary: 'Get training by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: trainingResponseSchema,
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const updateTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Update training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      category: { type: 'string', enum: trainingCategoryValues },
      bodySegment: { type: 'string', enum: bodySegmentValues },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    200: trainingResponseSchema,
    400: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const deleteTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Delete training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        deletedAt: { type: 'string', format: 'date-time' },
      },
    },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const importTrainingFromTemplateSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Create training from template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['protocolId', 'templateId'],
    properties: {
      protocolId: { type: 'string', format: 'uuid' },
      templateId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: trainingResponseSchema,
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const scheduleTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Schedule training on weekdays',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['weekDays'],
    properties: {
      weekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayValues },
        minItems: 1,
      },
      order: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'array',
      items: scheduleResponseSchema,
    },
    400: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

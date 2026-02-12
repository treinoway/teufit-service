import { trainingCategoryValues, bodySegmentValues, weekDayValues } from '../../src/constants/training.js';

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
    201: { type: 'object' },
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
  response: { 200: { type: 'array', items: { type: 'object' } } },
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
    200: { type: 'object' },
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
    200: { type: 'object' },
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
    200: { type: 'object' },
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
    201: { type: 'object' },
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
    201: { type: 'array', items: { type: 'object' } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

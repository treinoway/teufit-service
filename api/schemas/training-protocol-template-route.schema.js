import { weekDayValues } from '../../src/constants/training.js';

const weekDayEnum = weekDayValues;

export const createProtocolTemplateSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Create a new protocol template',
  description: 'Create a reusable protocol template (TRAINER only)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      availableWeekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayEnum },
      },
      defaultDurationWeeks: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        defaultDurationWeeks: { type: 'integer', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    400: { type: 'object', properties: { error: { type: 'string' } } },
    401: { type: 'object', properties: { error: { type: 'string' } } },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const getProtocolTemplatesSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Get all protocol templates',
  description: 'Get all protocol templates created by the authenticated trainer',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          trainerId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          availableWeekDays: { type: 'array', items: { type: 'string' } },
          defaultDurationWeeks: { type: 'integer', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

export const getProtocolTemplateByIdSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Get a protocol template by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        defaultDurationWeeks: { type: 'integer', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const updateProtocolTemplateSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Update a protocol template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      availableWeekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayEnum },
      },
      defaultDurationWeeks: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        defaultDurationWeeks: { type: 'integer', nullable: true },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

export const deleteProtocolTemplateSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Delete a protocol template',
  description: 'Soft delete a protocol template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
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

import { weekDayValues, trainingStatusValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const weekDayEnum = weekDayValues;
const statusEnum = trainingStatusValues;

const assigneeSchema = {
  type: 'object',
  nullable: true,
  description: 'User assigned to this protocol (assignee)',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'User ID' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

// Trainer schemas
export const createProtocolSchema = {
  tags: ['Training Protocols - Trainer'],
  summary: 'Create a training protocol for a user',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['assigneeId', 'name', 'startDate'],
    properties: {
      assigneeId: { type: 'string', format: 'uuid', description: 'User ID of the protocol assignee' },
      protocolTemplateId: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      availableWeekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayEnum },
      },
      status: { type: 'string', enum: statusEnum },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      description: 'Created protocol with assignee info',
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        assigneeId: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        assignee: assigneeSchema,
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

export const getTrainerProtocolsSchema = {
  tags: ['Training Protocols - Trainer'],
  summary: 'Get protocols created by trainer',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: statusEnum },
      assigneeId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          assigneeId: { type: 'string', format: 'uuid' },
          trainerId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          status: { type: 'string' },
          startDate: { type: 'string', format: 'date' },
          expirationDate: { type: 'string', format: 'date', nullable: true },
          assignee: assigneeSchema,
          protocolTemplate: { type: 'object', nullable: true },
        },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getProtocolByIdSchema = {
  tags: ['Training Protocols'],
  summary: 'Get protocol by ID',
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
        assigneeId: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        assignee: assigneeSchema,
        trainer: { type: 'object' },
        trainings: { type: 'array' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateProtocolSchema = {
  tags: ['Training Protocols - Trainer'],
  summary: 'Update a training protocol',
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
      status: { type: 'string', enum: statusEnum },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      description: 'Updated protocol with assignee info',
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        assigneeId: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        assignee: assigneeSchema,
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

export const deleteProtocolSchema = {
  tags: ['Training Protocols - Trainer'],
  summary: 'Delete a training protocol',
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
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const importFromTemplateSchema = {
  tags: ['Training Protocols - Trainer'],
  summary: 'Create protocol from template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['templateId', 'assigneeId'],
    properties: {
      templateId: { type: 'string', format: 'uuid' },
      assigneeId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      availableWeekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayEnum },
      },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      description: 'Protocol created from template with assignee info',
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        assigneeId: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        protocolTemplateId: { type: 'string', format: 'uuid', nullable: true },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        assignee: assigneeSchema,
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// My protocols schemas
const trainerInfoSchema = {
  type: 'object',
  nullable: true,
  description: 'Trainer who created this protocol',
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

export const getMyProtocolsSchema = {
  tags: ['Training Protocols - My'],
  summary: 'Get protocols assigned to user',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: statusEnum },
    },
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          assigneeId: { type: 'string', format: 'uuid' },
          trainerId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          status: { type: 'string' },
          startDate: { type: 'string', format: 'date' },
          expirationDate: { type: 'string', format: 'date', nullable: true },
          trainer: trainerInfoSchema,
          trainings: { type: 'array' },
        },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyProtocolByIdSchema = {
  tags: ['Training Protocols - My'],
  summary: 'Get protocol by ID (assignee view)',
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
        assigneeId: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        protocolTemplateId: { type: 'string', format: 'uuid', nullable: true },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        trainer: trainerInfoSchema,
        trainings: { type: 'array' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

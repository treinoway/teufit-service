import { weekDayValues, trainingStatusValues } from '../../src/constants/training.js';

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
    404: { type: 'object', properties: { error: { type: 'string' } } },
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
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
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
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
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
    200: { type: 'object' },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
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
    201: { type: 'object' },
    403: { type: 'object', properties: { error: { type: 'string' } } },
    404: { type: 'object', properties: { error: { type: 'string' } } },
  },
};

// Student schemas
export const getStudentProtocolsSchema = {
  tags: ['Training Protocols - Student'],
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
          name: { type: 'string' },
          status: { type: 'string' },
          startDate: { type: 'string', format: 'date' },
          expirationDate: { type: 'string', format: 'date', nullable: true },
          trainer: { type: 'object' },
          trainings: { type: 'array' },
        },
      },
    },
  },
};

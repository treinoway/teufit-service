import { trainingStatusValues, genderOrdinationValues, trainingLevelValues, protocolTypeValues, exerciseTypeValues, prescriptionModeValues, exerciseIntensityValues, trainingCategoryValues, bodySegmentValues, weekDayValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import { gifUrlRequestSchema } from './gif-url.schema.js';

const statusEnum = trainingStatusValues;
const genderOrdinationEnum = genderOrdinationValues;
const trainingLevelEnum = trainingLevelValues;
const protocolTypeEnum = protocolTypeValues;

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

const trainingItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('category', 'trainingCategory'),
    ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
    ...i18nField('weekDay', 'weekDay', { nullable: true }),
    order: { type: 'integer' },
    estimatedDurationSeconds: { type: 'integer', minimum: 0, nullable: true },
    notes: { type: 'string', nullable: true },
  },
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
      status: { type: 'string', enum: statusEnum },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      type: { type: 'string', enum: protocolTypeEnum },
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
        ...i18nField('status', 'trainingStatus'),
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
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
          ...i18nField('status', 'trainingStatus'),
          startDate: { type: 'string', format: 'date' },
          expirationDate: { type: 'string', format: 'date', nullable: true },
          ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
          ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
          ...i18nField('type', 'protocolType', { nullable: true }),
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
        ...i18nField('status', 'trainingStatus'),
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
        assignee: assigneeSchema,
        trainer: { type: 'object' },
        trainings: { type: 'array', items: trainingItemSchema },
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
      status: { type: 'string', enum: statusEnum },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      type: { type: 'string', enum: protocolTypeEnum },
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
        ...i18nField('status', 'trainingStatus'),
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
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
    409: errorResponseSchema,
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
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      type: { type: 'string', enum: protocolTypeEnum },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      description: 'Protocol created from template with assignee info and copied trainings',
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        assigneeId: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        protocolTemplateId: { type: 'string', format: 'uuid', nullable: true },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        ...i18nField('status', 'trainingStatus'),
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
        createdAt: { type: 'string', format: 'date-time' },
        assignee: assigneeSchema,
        trainings: { type: 'array', items: trainingItemSchema },
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
          ...i18nField('status', 'trainingStatus'),
          startDate: { type: 'string', format: 'date' },
          expirationDate: { type: 'string', format: 'date', nullable: true },
          ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
          ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
          ...i18nField('type', 'protocolType', { nullable: true }),
          trainer: trainerInfoSchema,
          trainings: { type: 'array', items: trainingItemSchema },
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
        ...i18nField('status', 'trainingStatus'),
        startDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
        createdAt: { type: 'string', format: 'date-time' },
        trainer: trainerInfoSchema,
        trainings: { type: 'array', items: trainingItemSchema },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Bulk create: protocol + trainings + exercises in one request ─────────────

const exerciseInputSchema = {
  type: 'object',
  required: ['name', 'type', 'order'],
  additionalProperties: false,
  properties: {
    exerciseTemplateId: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: exerciseTypeValues },
    videoUrl: { type: 'string' },
    gifUrl: gifUrlRequestSchema,
    order: { type: 'integer', minimum: 0 },
    sets: { type: 'integer', minimum: 1, nullable: true },
    repetitions: {
      anyOf: [
        {
          type: 'object',
          properties: {
            min: { type: 'integer', minimum: 1, nullable: true },
            max: { type: 'integer', minimum: 1, nullable: true },
          },
          additionalProperties: false,
        },
        { type: 'integer', minimum: 1 },
        { type: 'null' },
      ],
    },
    duration: { type: 'integer', minimum: 1, nullable: true },
    prescriptionMode: { type: 'string', enum: prescriptionModeValues },
    hasLoad: { type: 'boolean' },
    suggestedLoad: { type: 'number', nullable: true },
    restInterval: { type: 'integer', minimum: 0, nullable: true },
    notes: { type: 'string', nullable: true },
    intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
  },
};

const trainingInputSchema = {
  type: 'object',
  required: ['name', 'category', 'order'],
  additionalProperties: false,
  properties: {
    trainingTemplateId: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', nullable: true },
    category: { type: 'string', enum: trainingCategoryValues },
    bodySegment: { type: ['string', 'null'], enum: [...bodySegmentValues, null] },
    weekDay: { type: ['string', 'null'], enum: [...weekDayValues, null] },
    order: { type: 'integer', minimum: 0 },
    exercises: {
      type: 'array',
      items: exerciseInputSchema,
      default: [],
    },
  },
};

const protocolWithTrainingsResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    assigneeId: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    protocolTemplateId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('status', 'trainingStatus'),
    startDate: { type: 'string', format: 'date' },
    expirationDate: { type: 'string', format: 'date', nullable: true },
    ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
    ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
    ...i18nField('type', 'protocolType', { nullable: true }),
    createdAt: { type: 'string', format: 'date-time' },
    assignee: assigneeSchema,
    trainings: { type: 'array', items: trainingItemSchema },
  },
};

export const createProtocolWithTrainingsSchema = {
  tags: ['Training Protocols - Trainer'],
  summary: 'Create protocol with all trainings and exercises in one request',
  description:
    'Atomically creates a training protocol together with all its trainings and exercises. ' +
    'Replaces the sequential waterfall of POST /trainer/protocols + T× POST trainings + T×E× POST exercises. ' +
    'Returns the created protocol with its trainings list (exercises are not included in the response).',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['assigneeId', 'name', 'startDate'],
    additionalProperties: false,
    properties: {
      assigneeId: { type: 'string', format: 'uuid', description: 'User ID of the protocol assignee' },
      protocolTemplateId: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      status: { type: 'string', enum: trainingStatusValues },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      genderOrdination: { type: 'string', enum: genderOrdinationValues },
      trainingLevel: { type: 'string', enum: trainingLevelValues },
      type: { type: 'string', enum: protocolTypeValues },
      trainings: {
        type: 'array',
        items: trainingInputSchema,
        default: [],
      },
    },
  },
  response: {
    201: {
      description: 'Protocol created atomically with all trainings and exercises',
      ...protocolWithTrainingsResponseSchema,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

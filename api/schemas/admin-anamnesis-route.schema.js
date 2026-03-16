import { anamnesisQuestionTypeValues } from '../../src/constants/anamnesis.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';

// ─── Shared sub-schemas (mirroring anamnesis-route.schema.js) ─────────────────

const questionOptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    questionId: { type: 'string', format: 'uuid' },
    text: { type: 'string' },
    order: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const questionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sectionId: { type: 'string', format: 'uuid' },
    text: { type: 'string' },
    type: { type: 'string', enum: anamnesisQuestionTypeValues },
    required: { type: 'boolean' },
    order: { type: 'integer' },
    config: { nullable: true },
    options: { type: 'array', items: questionOptionSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const sectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    order: { type: 'integer' },
    questions: { type: 'array', items: questionSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const anamnesisSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid', nullable: true },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    isGeneral: { type: 'boolean' },
    version: { type: 'integer' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
    sections: { type: 'array', items: sectionSchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const anamnesisListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid', nullable: true },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    isGeneral: { type: 'boolean' },
    version: { type: 'integer' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          order: { type: 'integer' },
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const deletedAtResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    deletedAt: { type: 'string', format: 'date-time' },
  },
};

const questionOptionBodySchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1 },
    order: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const questionBodySchema = {
  type: 'object',
  required: ['text', 'type'],
  properties: {
    text: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: anamnesisQuestionTypeValues },
    required: { type: 'boolean' },
    order: { type: 'integer', minimum: 0 },
    config: { type: 'object', nullable: true },
    options: { type: 'array', items: questionOptionBodySchema },
  },
  additionalProperties: false,
};

const sectionBodySchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', nullable: true },
    order: { type: 'integer', minimum: 0 },
    questions: { type: 'array', items: questionBodySchema },
  },
  additionalProperties: false,
};

// ─── Anamnesis CRUD schemas ───────────────────────────────────────────────────

export const createPublicAnamnesisSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Create a public anamnesis with optional nested sections and questions',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string', nullable: true },
      sections: { type: 'array', items: sectionBodySchema },
    },
    additionalProperties: false,
  },
  response: {
    201: anamnesisSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listPublicAnamnesisSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'List all public anamneses',
  security: [{ bearerAuth: [] }],
  response: {
    200: { type: 'array', items: anamnesisListItemSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getPublicAnamnesisSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Get full detail of a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: anamnesisSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updatePublicAnamnesisSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Update a public anamnesis metadata (title, description)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string', nullable: true },
    },
    additionalProperties: false,
  },
  response: {
    200: anamnesisSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deletePublicAnamnesisSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Soft-delete a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: deletedAtResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Section schemas ──────────────────────────────────────────────────────────

export const addPublicSectionSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Add a section to a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  body: sectionBodySchema,
  response: {
    201: sectionSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updatePublicSectionSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Update a section on a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId', 'sectionId'],
    properties: {
      anamnesisId: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string', nullable: true },
      order: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  response: {
    200: sectionSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deletePublicSectionSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Soft-delete a section on a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId', 'sectionId'],
    properties: {
      anamnesisId: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: deletedAtResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const reorderPublicSectionsSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Reorder sections within a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['orderedIds'],
    properties: {
      orderedIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: { type: 'array', items: sectionSchema },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Question schemas ─────────────────────────────────────────────────────────

export const addPublicQuestionSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Add a question to a section on a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId', 'sectionId'],
    properties: {
      anamnesisId: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
    },
  },
  body: questionBodySchema,
  response: {
    201: questionSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updatePublicQuestionSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Update a question on a public anamnesis (replaces options if provided)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId', 'sectionId', 'questionId'],
    properties: {
      anamnesisId: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
      questionId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: anamnesisQuestionTypeValues },
      required: { type: 'boolean' },
      order: { type: 'integer', minimum: 0 },
      config: { type: 'object', nullable: true },
      options: { type: 'array', items: questionOptionBodySchema },
    },
    additionalProperties: false,
  },
  response: {
    200: questionSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deletePublicQuestionSchema = {
  tags: ['Anamnesis - Admin'],
  summary: 'Soft-delete a question on a public anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId', 'sectionId', 'questionId'],
    properties: {
      anamnesisId: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
      questionId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: deletedAtResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

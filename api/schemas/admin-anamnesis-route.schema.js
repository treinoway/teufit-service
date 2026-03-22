import { anamnesisQuestionTypeValues } from '../../src/constants/anamnesis.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import {
  questionSchema,
  sectionSchema,
  anamnesisSchema,
  anamnesisListItemSchema,
  deletedAtResponseSchema,
  questionOptionBodySchema,
  questionBodySchema,
  sectionBodySchema,
} from './anamnesis-shared.schema.js';

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
    409: errorResponseSchema,
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
    409: errorResponseSchema,
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
      config: { anyOf: [{ type: 'object' }, { type: 'null' }] },
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

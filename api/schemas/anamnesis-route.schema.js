import { anamnesisQuestionTypeValues } from '../../src/constants/anamnesis.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import {
  questionOptionSchema,
  questionSchema,
  sectionSchema,
  anamnesisSchema,
  anamnesisListItemSchema,
  deletedAtResponseSchema,
  questionOptionBodySchema,
  questionBodySchema,
  sectionBodySchema,
  conditionSchema,
} from './anamnesis-shared.schema.js';

// Re-export shared sub-schemas for use by other modules if needed
export {
  questionOptionSchema,
  questionSchema,
  sectionSchema,
  anamnesisSchema,
  anamnesisListItemSchema,
  deletedAtResponseSchema,
};

// ─── Anamnesis CRUD schemas ───────────────────────────────────────────────────

export const createAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'Create a new anamnesis with optional nested sections and questions',
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
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'List anamneses (private + general)',
  security: [{ bearerAuth: [] }],
  response: {
    200: { type: 'array', items: anamnesisListItemSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'Get full detail of an anamnesis',
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

export const updateAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'Update anamnesis metadata (title, description)',
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

export const deleteAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'Soft-delete an anamnesis',
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

export const addSectionSchema = {
  tags: ['Anamnesis - Sections'],
  summary: 'Add a section to an anamnesis',
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

export const reorderSectionsSchema = {
  tags: ['Anamnesis - Sections'],
  summary: 'Reorder sections within an anamnesis',
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

export const updateSectionSchema = {
  tags: ['Anamnesis - Sections'],
  summary: 'Update a section',
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

export const deleteSectionSchema = {
  tags: ['Anamnesis - Sections'],
  summary: 'Soft-delete a section',
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

// ─── Question schemas ─────────────────────────────────────────────────────────

export const addQuestionSchema = {
  tags: ['Anamnesis - Questions'],
  summary: 'Add a question to a section',
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

export const updateQuestionSchema = {
  tags: ['Anamnesis - Questions'],
  summary: 'Update a question (replaces options if provided)',
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
      parentQuestionId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      condition: conditionSchema,
    },
    additionalProperties: false,
  },
  response: {
    200: questionSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteQuestionSchema = {
  tags: ['Anamnesis - Questions'],
  summary: 'Soft-delete a question',
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

// ─── Student linking schemas ──────────────────────────────────────────────────

const studentAnamnesisLinkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    anamnesis: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        isGeneral: { type: 'boolean' },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const studentAnamnesisListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    anamnesis: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        isGeneral: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
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
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const linkAnamnesisToStudentSchema = {
  tags: ['Anamnesis - Student Linking'],
  summary: 'Link an anamnesis to a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: { studentId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['anamnesisId'],
    properties: {
      anamnesisId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },
  response: {
    201: studentAnamnesisLinkSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listStudentAnamnesisSchema = {
  tags: ['Anamnesis - Student Linking'],
  summary: 'List anamneses linked to a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: { studentId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: { type: 'array', items: studentAnamnesisListItemSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const unlinkAnamnesisFromStudentSchema = {
  tags: ['Anamnesis - Student Linking'],
  summary: 'Unlink an anamnesis from a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId', 'anamnesisId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
      anamnesisId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Student (my) schemas ─────────────────────────────────────────────────────

const myAnamnesisItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    anamnesis: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        isGeneral: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        sections: { type: 'array', items: sectionSchema },
      },
    },
    trainer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        user: {
          type: 'object',
          properties: {
            firstName: { type: 'string', nullable: true },
            lastName: { type: 'string', nullable: true },
            avatarUrl: { type: 'string', nullable: true },
          },
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const getMyAnamnesisSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Get my linked anamneses (student view)',
  security: [{ bearerAuth: [] }],
  response: {
    200: { type: 'array', items: myAnamnesisItemSchema },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Versioning schemas ───────────────────────────────────────────────────────

export const forkAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'Fork an anamnesis into a new version',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  response: {
    201: anamnesisSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const copyAnamnesisSchema = {
  tags: ['Anamnesis - Trainer'],
  summary: 'Copy an anamnesis into a new independent private copy (parentId: null, version: 1)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  response: {
    201: anamnesisSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Response schemas ─────────────────────────────────────────────────────────

const anamnesisAnswerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    responseId: { type: 'string', format: 'uuid' },
    questionId: { type: 'string', format: 'uuid' },
    value: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array' },
        { type: 'object' },
        { type: 'null' },
      ],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const anamnesisResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', format: 'uuid' },
    submittedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
    answers: { type: 'array', items: anamnesisAnswerSchema },
  },
};

const answerBodySchema = {
  type: 'object',
  required: ['questionId', 'value'],
  properties: {
    questionId: { type: 'string', format: 'uuid' },
    value: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array' },
        { type: 'object' },
        { type: 'null' },
      ],
    },
  },
  additionalProperties: false,
};

export const submitAnamnesisResponseSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Submit (or resubmit) a response to an anamnesis — idempotent upsert, always returns 200',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['answers'],
    properties: {
      answers: {
        type: 'array',
        items: answerBodySchema,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: anamnesisResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyAnamnesisResponseSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Get my response to an anamnesis',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: anamnesisResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getStudentAnamnesisResponseSchema = {
  tags: ['Anamnesis - Student Linking'],
  summary: "Get a student's response to an anamnesis (trainer view)",
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId', 'anamnesisId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
      anamnesisId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: anamnesisResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

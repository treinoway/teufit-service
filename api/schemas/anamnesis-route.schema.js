import { anamnesisQuestionTypeValues, ANAMNESIS_DRAFT_MAX_ANSWERS } from '../../src/constants/anamnesis.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
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

// Compact summary of the student's response embedded in the anamnesis lists (trainer and
// student). Never carries answers. `nullable` object (not anyOf) so the i18n label walker
// can reach the nested categorical fields.
const responseSummarySchema = {
  type: 'object',
  nullable: true,
  description:
    'Summary of the student response (draft, awaiting_confirmation or submitted); null when nothing was saved yet. ' +
    'answeredCount counts stored answers, including hidden conditional answers kept in drafts.',
  properties: {
    ...i18nField('status', 'anamnesisResponseStatus'),
    // Who wrote the response. Only meaningful once status is not "draft".
    ...i18nField('filledBy', 'anamnesisFilledBy'),
    submittedAt: { type: 'string', format: 'date-time', nullable: true },
    answeredCount: { type: 'integer' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
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
    response: responseSummarySchema,
    canFill: {
      type: 'boolean',
      description:
        'Whether this trainer may still finalize the response: false when the student already submitted it ' +
        'or another trainer filled it in',
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
    response: responseSummarySchema,
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
    ...i18nField('status', 'anamnesisResponseStatus'),
    // Who wrote the response. Only meaningful once status is not "draft".
    ...i18nField('filledBy', 'anamnesisFilledBy'),
    trainerAttestedAt: { type: 'string', format: 'date-time', nullable: true },
    studentConfirmedAt: { type: 'string', format: 'date-time', nullable: true },
    answers: { type: 'array', items: anamnesisAnswerSchema },
  },
};

const answerBodySchema = {
  type: 'object',
  required: ['questionId', 'value'],
  properties: {
    questionId: { type: 'string', format: 'uuid' },
    // Intentionally untyped: with Fastify's `coerceTypes: 'array'`, a typed anyOf
    // coerces ["A"] → "A", 0 → "0", false → "false" and null → "", which hides
    // conditional children of single-selection multiple-choice parents.
    value: {
      description: 'Answer value (string, number, boolean, array, object or null), stored as sent.',
    },
  },
  additionalProperties: false,
};

const draftBodySchema = {
  type: 'object',
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: answerBodySchema,
      minItems: 1,
      maxItems: ANAMNESIS_DRAFT_MAX_ANSWERS,
    },
  },
  additionalProperties: false,
};

export const submitAnamnesisResponseSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Submit (finalize) a response to an anamnesis — idempotent upsert, always returns 200',
  description:
    'Finalizes the response: validates required visible questions, replaces all stored answers with the ' +
    'payload and marks the response as submitted (status "submitted"). If a draft was saved earlier via ' +
    'PATCH /my/anamneses/{anamnesisId}/response/draft, it is converted into the submitted response. ' +
    'The response becomes student-authored (filledBy "student") and confirmed (studentConfirmedAt set), ' +
    'also when it corrects a response the trainer filled on the student\'s behalf.',
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

export const saveAnamnesisResponseDraftSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Save a partial (draft) response to an anamnesis',
  description:
    'Upserts only the answers present in the payload; other stored answers are untouched. An empty value ' +
    '(null, blank string or empty array) clears that question\'s stored answer. Required questions are NOT ' +
    'validated and answers of currently hidden conditional questions are kept. Drafts are invisible in the ' +
    'trainer dossier (GET /trainer/students/{studentId}/anamneses/{anamnesisId}/response) until the response ' +
    'is finalized with POST /my/anamneses/{anamnesisId}/response; the trainer only sees a student draft ' +
    'through the fill flow (GET .../fill), after attesting the student is present. ' +
    'Returns 409 ANAMNESIS_RESPONSE_ALREADY_SUBMITTED once the response has been submitted.',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['anamnesisId'],
    properties: { anamnesisId: { type: 'string', format: 'uuid' } },
  },
  body: draftBodySchema,
  response: {
    200: anamnesisResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyAnamnesisResponseSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Get my response to an anamnesis (draft or submitted)',
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
  summary: "Get a student's submitted response to an anamnesis (trainer view) — drafts are not visible (404)",
  description:
    'Returns responses that have been finalized, by the student or by the trainer on the student\'s behalf. ' +
    'Check status ("awaiting_confirmation" | "submitted"), filledBy and studentConfirmedAt to tell them apart.',
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

export const confirmAnamnesisResponseSchema = {
  tags: ['Anamnesis - My'],
  summary: 'Confirm a response the trainer filled on my behalf',
  description:
    'Only valid while the response status is "awaiting_confirmation" (finalized by the trainer, not yet ' +
    'confirmed). Sets studentConfirmedAt; answers are left untouched and the status becomes "submitted". ' +
    'Returns 409 ANAMNESIS_RESPONSE_NOT_AWAITING_CONFIRMATION for any other status, and 404 when the ' +
    'anamnesis is not linked to the student or there is no response yet.',
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
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Trainer fills on behalf of the student ───────────────────────────────────

const trainerFillParamsSchema = {
  type: 'object',
  required: ['studentId', 'anamnesisId'],
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    anamnesisId: { type: 'string', format: 'uuid' },
  },
};

const trainerFillErrorResponses = {
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
};

const trainerFillAccessDescription =
  'The student must be linked to the trainer and active on the plan, and this trainer must have linked this ' +
  'anamnesis to this student (404 ANAMNESIS_NOT_LINKED_TO_STUDENT otherwise).';

export const getTrainerAnamnesisFillSchema = {
  tags: ['Anamnesis - Trainer Fill'],
  summary: 'Load the anamnesis and the current response to fill it with the student (trainer)',
  description:
    'Returns the full anamnesis plus the current response regardless of its author (including the student\'s ' +
    'draft), or null when nothing was saved yet. The client must send studentPresent=true, which is the ' +
    'trainer\'s attestation that the student is present and authorized (400 VALIDATION_ERROR otherwise). ' +
    trainerFillAccessDescription,
  security: [{ bearerAuth: [] }],
  params: trainerFillParamsSchema,
  querystring: {
    type: 'object',
    required: ['studentPresent'],
    properties: {
      studentPresent: {
        type: 'boolean',
        const: true,
        description: 'Trainer attestation that the student is present and authorized. Must be true.',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        anamnesis: anamnesisSchema,
        response: { ...anamnesisResponseSchema, nullable: true },
        canFinalize: {
          type: 'boolean',
          description:
            'Whether this trainer may finalize the response: false when the student already submitted it ' +
            'or when another trainer filled it in.',
        },
      },
    },
    ...trainerFillErrorResponses,
  },
};

export const saveTrainerAnamnesisResponseDraftSchema = {
  tags: ['Anamnesis - Trainer Fill'],
  summary: "Save a partial (draft) response on the student's behalf (trainer)",
  description:
    'Same semantics as PATCH /my/anamneses/{anamnesisId}/response/draft: only the answers present are ' +
    'upserted, empty values clear the stored answer, required questions are not validated. Authorship is not ' +
    'changed by a draft. Returns 409 ANAMNESIS_RESPONSE_ALREADY_SUBMITTED once the response has been ' +
    'submitted (by either party). ' + trainerFillAccessDescription,
  security: [{ bearerAuth: [] }],
  params: trainerFillParamsSchema,
  body: draftBodySchema,
  response: {
    200: anamnesisResponseSchema,
    ...trainerFillErrorResponses,
    409: errorResponseSchema,
  },
};

export const submitTrainerAnamnesisResponseSchema = {
  tags: ['Anamnesis - Trainer Fill'],
  summary: "Finalize the response on the student's behalf (trainer) — awaits the student's confirmation",
  description:
    'Same validation as the student submit (required visible questions, answers of hidden questions dropped, ' +
    'unknown question 404). The body must carry attestation.studentPresent=true. The response is stored with ' +
    'filledBy "trainer", trainerAttestedAt=now, studentConfirmedAt=null, so its status is ' +
    '"awaiting_confirmation" until the student calls POST /my/anamneses/{anamnesisId}/response/confirm. ' +
    'The trainer may re-finalize their own submission (this resets the confirmation) but never overwrites ' +
    'a response submitted by the student (409 ANAMNESIS_RESPONSE_SUBMITTED_BY_STUDENT) nor one filled in by ' +
    'another trainer (409 ANAMNESIS_RESPONSE_FILLED_BY_ANOTHER_TRAINER; allowed when that trainer\'s user was ' +
    'deleted). ' +
    trainerFillAccessDescription,
  security: [{ bearerAuth: [] }],
  params: trainerFillParamsSchema,
  body: {
    type: 'object',
    required: ['answers', 'attestation'],
    properties: {
      answers: {
        type: 'array',
        items: answerBodySchema,
      },
      attestation: {
        type: 'object',
        required: ['studentPresent'],
        properties: {
          studentPresent: {
            type: 'boolean',
            const: true,
            description: 'Trainer attestation that the student is present and authorized. Must be true.',
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: anamnesisResponseSchema,
    ...trainerFillErrorResponses,
    409: errorResponseSchema,
  },
};
